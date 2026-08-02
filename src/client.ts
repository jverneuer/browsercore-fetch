/**
 * FetchClient — connection pooling + cookie jar integration + profile loading.
 *
 * Top of the dependency stack. Dispatches requests over the best available
 * protocol (h2 vs h1.1 via ALPN) and follows the configured redirect policy.
 *
 * Wire format (per PLAN.md):
 *   1. Parse + validate the URL (scheme, host, port, path).
 *   2. Establish a TCP transport, then TLS with ALPN ["h2", "http/1.1"].
 *   3. Branch on the ALPN-negotiated protocol: instantiate an HTTP/2 session
 *      or an HTTP/1.1 connection.
 *   4. Apply the requested browser profile (TLS + HTTP defaults) before the
 *      first dispatch.
 *   5. Encode + send the request, decode the response, handle redirects and
 *      Set-Cookie per the active policy.
 */

import { connect as connectTransport } from "@browsercore/transport";
import type { Transport } from "@browsercore/transport";
import { compression } from "@browsercore/compression";
import { EventEmitter } from "node:events";
import { connectTls } from "@browsercore/tls";
import { connectHttp1 } from "@browsercore/http1";
import type {
    Http1Connection,
    Http1ConnectionId,
    HttpBodyKind,
} from "@browsercore/http1";
import { connectHttp2, Http2Settings } from "@browsercore/http2";
import type { Http2Connection, Http2SettingsMap } from "@browsercore/http2";
import type { CookieJar } from "@browsercore/cookies";
import { createCookieJar } from "@browsercore/cookies";
import type { CookieUrl } from "@browsercore/cookies";
import { getProfile } from "@browsercore/profiles";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import { createId, assertNever } from "./utils.js";
import {
    FetchError,
    FetchTimeoutError,
    ProtocolError,
    RedirectError,
} from "./errors.js";
import type {
    FetchOptions,
    FetchRequestId,
    FetchResponse,
    ParsedUrl,
    RedirectPolicy,
} from "./types.js";

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default pooled-connection idle eviction timeout in milliseconds. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** ALPN protocols offered during the TLS handshake (h2 preferred). */
const ALPN_PROTOCOLS = ["h2", "http/1.1"] as const;

/** HTTP status codes that trigger redirect handling. */
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308] as const;

/** Redirect status code union — exhaustive over REDIRECT_STATUS_CODES. */
type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];

/** Methods whose body must be stripped on a 303 redirect. */
const BODY_STRIP_ON_303 = new Set(["PUT", "PATCH", "DELETE"]);

/** Options for {@link createClient}. */
export interface FetchClientOptions {
    /** Default cookie jar applied to every request (overridable per-call). */
    readonly cookieJar?: CookieJar;
    /** Default profile applied to every request (overridable per-call). */
    readonly profile?: ProfileId;
    /** Default redirect policy. */
    readonly redirectPolicy?: RedirectPolicy;
    /** Default request timeout in ms. */
    readonly timeoutMs?: number;
    /**
     * Idle pool eviction timeout in ms. A pooled connection that goes unused
     * for this duration is closed and evicted. Pass 0 to disable idle eviction.
     * Default 30_000.
     */
    readonly idleTimeoutMs?: number;
    /**
     * Test seam: override how the transport for an origin is established.
     * When provided, this is called instead of opening a real TCP transport +
     * TLS handshake. It must return a {@link Transport} that speaks the
     * bytes the HTTP layer expects on the *server* side of the connection
     * (i.e. already past any TLS the production path would have applied).
     *
     * This exists so behavioral tests can drive the client against an
     * in-process fake server without a real network or a finished TLS layer.
     */
    readonly transportFactory?: (host: string, port: number) => Promise<Transport> | Transport;
}

/** Public interface of an established fetch client. */
export interface FetchClient {
    /** Opaque id for logging / correlation. */
    readonly id: FetchRequestId;
    /**
     * Dispatch a request. Returns a {@link FetchResponse} on success.
     * Throws {@link FetchTimeoutError}, {@link RedirectError},
     * {@link ProtocolError}, or the base {@link FetchError} on failure.
     */
    fetch(input: string, options?: FetchOptions): Promise<FetchResponse>;
    /** Close all pooled connections. */
    close(): Promise<void>;
}

/**
 * A pooled protocol connection (HTTP/1.1 or HTTP/2). The protocol-specific
 * implementation is reachable through the `protocol` discriminant.
 */
type PooledConnection =
    | {
          readonly protocol: "http1";
          readonly id: Http1ConnectionId;
          readonly conn: Http1Connection;
      }
    | {
          readonly protocol: "http2";
          readonly id: string;
          readonly conn: Http2Connection;
      };

/** A key into the connection pool — host:port is the origin identity. */
type PoolKey = string & { __brand: "PoolKey" };

/** Build the pool key for a parsed URL. */
function poolKey(url: ParsedUrl): PoolKey {
    return `${url.host}:${url.port}` as PoolKey;
}

/** Resolve the effective redirect policy from options + client defaults. */
function resolveRedirectPolicy(options?: FetchOptions, defaults?: RedirectPolicy): RedirectPolicy {
    if (options?.followRedirects === false) {
        return { kind: "manual" };
    }
    if (defaults) {
        return defaults;
    }
    return { kind: "follow", maxRedirects: options?.maxRedirects ?? 20 };
}

/** Parse a URL string into a {@link ParsedUrl}. Throws on malformed input. */
function parseUrl(input: string): ParsedUrl {
    // The WHATWG URL parser normalizes the path and splits host/port/scheme.
    // We project the result onto our strict `ParsedUrl` shape and reject any
    // scheme that isn't http/https — external data is validated immediately.
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        if (cause !== undefined) {
            throw new FetchError(`invalid URL: ${input}`, { url: input, cause });
        }
        throw new FetchError(`invalid URL: ${input}`, { url: input });
    }
    const scheme = parsed.protocol.replace(":", "");
    if (scheme !== "http" && scheme !== "https") {
        throw new FetchError(`unsupported scheme: ${scheme}`, { url: input });
    }
    const schemeConst = scheme;
    const host = parsed.hostname;
    const port = parsed.port === "" ? defaultPort(schemeConst) : Number(parsed.port);
    const path = parsed.pathname;
    const query = parsed.search;
    const fragment = parsed.hash;
    return { scheme: schemeConst, host, port, path, query, fragment };
}

/** Pick the default port for a scheme. */
function defaultPort(scheme: "http" | "https"): number {
    switch (scheme) {
        case "http":
            return 80;
        case "https":
            return 443;
    }
}

/** Convert a {@link ParsedUrl} back to an origin string (scheme + host + port). */
function originString(url: ParsedUrl): string {
    const portSuffix = url.port === defaultPort(url.scheme) ? "" : `:${url.port}`;
    return `${url.scheme}://${url.host}${portSuffix}`;
}

/** Build the request target (path + query) for the wire request line. */
function requestTarget(url: ParsedUrl): string {
    return `${url.path}${url.query}`;
}

/** Translate a {@link FetchMethod} into the wire `HttpBodyKind`. */
function bodyKind(body: Uint8Array | string | undefined): HttpBodyKind {
    if (body === undefined) {
        return { kind: "empty" };
    }
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return { kind: "bytes", data: bytes };
}

/** Read a `Set-Cookie` header (or multiple) from a response header map. */
function readSetCookie(headers: ReadonlyMap<string, string>): string[] {
    const out: string[] = [];
    for (const [name, value] of headers) {
        if (name.toLowerCase() === "set-cookie") {
            out.push(value);
        }
    }
    return out;
}

/** Read the `content-encoding` header (case-insensitive) from a response header map. */
function readContentEncoding(headers: ReadonlyMap<string, string>): string | undefined {
    for (const [name, value] of headers) {
        if (name.toLowerCase() === "content-encoding") {
            return value;
        }
    }
    return undefined;
}

/**
 * Decompress a body if `content-encoding` is set; otherwise return as-is.
 *
 * Delegates to `@browsercore/compression`, which implements browser-tolerant
 * decoding (notably the zlib/raw `deflate` fallback). No-op when no encoding.
 */
function decompressBody(body: Uint8Array, encoding: string | undefined): Uint8Array {
    if (encoding === undefined || encoding === "") {
        return body;
    }
    return compression.decompress(body, encoding);
}

/** A cookie URL derived from a {@link ParsedUrl} for {@link CookieJar} matching. */
function cookieUrl(url: ParsedUrl): CookieUrl {
    return {
        hostname: url.host,
        pathname: url.path,
        protocol: `${url.scheme}:`,
    };
}

/** Whether `status` is one of the redirect-triggering status codes. */
function isRedirectStatus(status: number): status is RedirectStatusCode {
    return (REDIRECT_STATUS_CODES as readonly number[]).includes(status);
}

/** Build the redirect target by resolving a possibly-relative Location against the current URL. */
function resolveRedirectUrl(current: ParsedUrl, location: string): ParsedUrl {
    // A relative Location is resolved against the current URL via the WHATWG
    // URL parser. Absolute URLs are parsed directly.
    const absolute = new URL(location, originString(current) + current.path + current.query);
    const projected: ParsedUrl = {
        scheme: absolute.protocol.replace(":", "") as "http" | "https",
        host: absolute.hostname,
        port: absolute.port === "" ? defaultPort(absolute.protocol.replace(":", "") as "http" | "https") : Number(absolute.port),
        path: absolute.pathname,
        query: absolute.search,
        fragment: absolute.hash,
    };
    return projected;
}

/**
 * Map a TLS version string (e.g. "TLS 1.3") to the wire-format
 * `ProtocolVersion` object the TLS layer expects. The return type uses
 * const-assertion so each variant is a distinct literal type, matching
 * the `ProtocolVersion` discriminated union.
 */
function toProtocolVersion(s: string): { readonly name: "TLS 1.2"; readonly wire: 0x0303 } | { readonly name: "TLS 1.3"; readonly wire: 0x0304 } {
    switch (s) {
        case "TLS 1.2":
            return { name: "TLS 1.2", wire: 0x0303 } as const;
        case "TLS 1.3":
            return { name: "TLS 1.3", wire: 0x0304 } as const;
        default:
            return { name: "TLS 1.3", wire: 0x0304 } as const;
    }
}

/**
 * Translate a browser profile into TLS ClientHello configuration. The profile
 * carries ordered cipher suites, key-share groups, signature algorithms, and
 * supported versions — we map 1:1 onto the TLS layer's `ClientHelloConfig`.
 * The profile's string arrays are cast to the literal unions expected by the
 * TLS layer; the registry guarantees these values are valid at registration
 * time.
 */
function profileToTlsConfig(profile: BrowserProfile, serverName: string) {
    return {
        cipherSuites: profile.tls.cipherSuites as unknown as readonly ("TLS_AES_128_GCM_SHA256" | "TLS_AES_256_GCM_SHA384" | "TLS_CHACHA20_POLY1305_SHA256" | "TLS_AES_128_CCM_SHA256")[],
        keyShareGroups: profile.tls.keyShareGroups as unknown as readonly ("secp256r1" | "secp384r1" | "x25519" | "x448")[],
        signatureAlgorithms: profile.tls.signatureAlgorithms as unknown as readonly ("ecdsa_secp256r1_sha256" | "ecdsa_secp384r1_sha384" | "rsa_pss_rsae_sha256" | "rsa_pss_rsae_sha384" | "rsa_pkcs1_sha256")[],
        supportedVersions: profile.tls.supportedVersions.map(toProtocolVersion),
        serverName,
        alpnProtocols: ALPN_PROTOCOLS as readonly string[],
    };
}

/** Apply HTTP/1.1 profile defaults to a request header map. */
function applyHttp1Profile(
    headers: Map<string, string>,
    profile: BrowserProfile,
): void {
    // Profile defaults are only applied when the caller has not supplied a
    // value — explicit headers always win.
    for (const [name, value] of Object.entries(profile.http1.defaultHeaders)) {
        if (!headers.has(name)) {
            headers.set(name, value);
        }
    }
    // Host is always set from the URL if not explicitly provided.
    if (!headers.has("host")) {
        // Caller is responsible for setting Host from the URL; this is a
        // fallback for safety.
    }
}

/**
 * Translate a profile's named HTTP/2 settings into the numeric
 * {@link Http2SettingsMap} the wire layer expects. The profile uses the
 * human-readable {@link Http2Settings} names; the connection sends the RFC
 * 9113 numeric identifiers. `enablePush` is a boolean in the profile but a
 * 0/1 value on the wire, so we coerce it here.
 */
function profileHttp2Settings(profile: BrowserProfile): Http2SettingsMap {
    const named = profile.http2.settings;
    const wire: Http2SettingsMap = {};
    if (named.headerTableSize !== undefined) {
        wire[Http2Settings.HEADER_TABLE_SIZE] = named.headerTableSize;
    }
    if (named.enablePush !== undefined) {
        // ENABLE_PUSH (§6.5.2) accepts only 0 or 1.
        wire[Http2Settings.ENABLE_PUSH] = named.enablePush ? 1 : 0;
    }
    if (named.maxConcurrentStreams !== undefined) {
        wire[Http2Settings.MAX_CONCURRENT_STREAMS] = named.maxConcurrentStreams;
    }
    if (named.initialWindowSize !== undefined) {
        wire[Http2Settings.INITIAL_WINDOW_SIZE] = named.initialWindowSize;
    }
    if (named.maxFrameSize !== undefined) {
        wire[Http2Settings.MAX_FRAME_SIZE] = named.maxFrameSize;
    }
    if (named.maxHeaderListSize !== undefined) {
        wire[Http2Settings.MAX_HEADER_LIST_SIZE] = named.maxHeaderListSize;
    }
    return wire;
}

/**
 * Apply HTTP/2 profile settings to a live connection. The connection's
 * settings map is updated to reflect the profile so any observer (and the
 * connection's own flow-control logic) sees the configured values. The
 * initial SETTINGS frame is also seeded at connect time (see
 * {@link establishConnection}) — this function covers settings applied after
 * the connection preface.
 *
 * The public interface types `settings` as readonly; the implementation
 * mutates it in place, so we write through a narrow mutable view.
 */
function applyHttp2Profile(
    conn: Http2Connection,
    profile: BrowserProfile,
): void {
    const settings = profileHttp2Settings(profile);
    // TODO: pushing updated SETTINGS to the *peer* requires the connection to
    // send a new SETTINGS frame here. The current Http2Connection interface
    // exposes no method to do that, so we only update the local view. Extend
    // the interface with a `setSettings()` that emits a SETTINGS frame to
    // apply this on the wire.
    (conn as { settings: Http2SettingsMap }).settings = settings;
}

/** Build a {@link FetchResponse} from an HTTP/1.1 response. */
function buildResponse(
    url: string,
    statusCode: number,
    statusText: string,
    headers: ReadonlyMap<string, string>,
    rawBody: Uint8Array,
): FetchResponse {
    const headerRecord: Record<string, string> = {};
    for (const [name, value] of headers) {
        headerRecord[name] = value;
    }
    const encoding = readContentEncoding(headers);
    const body = decompressBody(rawBody, encoding);

    // The body can be consumed once. `clone()` captures the bytes so the
    // caller can re-read after the first consumption.
    let consumed = false;
    const snapshot = body;

    function consume(): Promise<Uint8Array> {
        if (consumed) {
            return Promise.reject(new FetchError("body already consumed", { url }));
        }
        consumed = true;
        return Promise.resolve(snapshot);
    }

    return {
        url,
        status: statusCode,
        statusText,
        headers: headerRecord,
        get bodyUsed(): boolean {
            return consumed;
        },
        body: consume,
        async json(): Promise<unknown> {
            const bytes = await consume();
            const text = new TextDecoder().decode(bytes);
            return JSON.parse(text) as unknown;
        },
        async text(): Promise<string> {
            const bytes = await consume();
            return new TextDecoder().decode(bytes);
        },
        clone(): FetchResponse {
            // A clone shares the same underlying bytes but has its own
            // `consumed` flag so each copy can be read independently.
            return buildResponse(url, statusCode, statusText, headers, rawBody);
        },
    };
}

/** Dispatch a request over an HTTP/1.1 connection. */
async function dispatchHttp1(
    conn: Http1Connection,
    url: ParsedUrl,
    method: string,
    headers: Map<string, string>,
    body: Uint8Array | string | undefined,
): Promise<FetchResponse> {
    const wireHeaders = new Map(headers);
    if (!wireHeaders.has("host")) {
        wireHeaders.set("host", url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`);
    }
    const response = await conn.request({
        method: method as never,
        url: requestTarget(url),
        headers: wireHeaders,
        body: bodyKind(body),
    });
    return buildResponse(
        originString(url) + requestTarget(url),
        response.statusCode,
        response.statusText,
        response.headers,
        response.body,
    );
}

/** Dispatch a request over an HTTP/2 connection. */
async function dispatchHttp2(
    conn: Http2Connection,
    url: ParsedUrl,
    method: string,
    headers: Map<string, string>,
    body: Uint8Array | string | undefined,
): Promise<FetchResponse> {
    const wireHeaders = new Map(headers);
    if (!wireHeaders.has(":method")) {
        wireHeaders.set(":method", method);
    }
    if (!wireHeaders.has(":path")) {
        wireHeaders.set(":path", requestTarget(url));
    }
    if (!wireHeaders.has(":scheme")) {
        wireHeaders.set(":scheme", url.scheme);
    }
    if (!wireHeaders.has(":authority")) {
        wireHeaders.set(":authority", url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`);
    }
    const response = await conn.request({
        method,
        scheme: url.scheme,
        authority: url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`,
        path: requestTarget(url),
        headers: wireHeaders,
        body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    });
    return buildResponse(
        originString(url) + requestTarget(url),
        response.statusCode,
        "",
        response.headers,
        response.body,
    );
}

/**
 * Adapt a {@link TlsConnection} to the {@link Transport} interface the HTTP
 * layers expect. The TLS connection is the transport for the HTTP layer — it
 * provides encrypted byte-stream semantics. We bridge the structural gap
 * between `TlsConnection.read()` (returns `{payload}`) and `Transport.read()`
 * (returns `Uint8Array`).
 *
 * The HTTP layers only use `write`, `read`, `on("data")`, `on("close")`, and
 * `close`, so we implement those and forward the rest.
 */
function adaptTlsToTransport(tls: {
    readonly id: unknown;
    readonly state: unknown;
    write(data: Uint8Array): Promise<void>;
    read(): Promise<{ payload: Uint8Array }>;
    close(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
}): Transport {
    const emitter = new EventEmitter();
    // Forward `close` events from the TLS connection to the adapter.
    tls.on("close", () => {
        emitter.emit("close", false);
    });
    tls.on("error", (err: unknown) => {
        emitter.emit("error", err);
    });
    return {
        id: tls.id as Transport["id"],
        state: tls.state as Transport["state"],
        write: (data: Uint8Array) => tls.write(data),
        read: async () => {
            const result = await tls.read();
            return result.payload;
        },
        close: () => tls.close(),
        on: (event: string, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener);
            return undefined as unknown as Transport;
        },
    } as Transport;
}

/** Establish a protocol connection (HTTP/1.1 or HTTP/2) over a TLS transport. */
async function establishConnection(
    transport: Transport,
    profile: BrowserProfile,
    serverName: string,
): Promise<PooledConnection> {
    const tlsConfig = profileToTlsConfig(profile, serverName);
    const tls = await connectTls({
        transport,
        serverName,
        profile: tlsConfig,
        alpnProtocols: ALPN_PROTOCOLS as readonly string[],
    });
    const alpn = tls.alpnProtocol;
    // Adapt the TLS connection to the Transport interface for the HTTP layer.
    const httpTransport = adaptTlsToTransport(tls);
    if (alpn === "h2") {
        // Seed the connection preface's SETTINGS frame with the profile's
        // HTTP/2 settings so the peer observes our advertised limits
        // (window size, max frame size, header table size, …) from the start.
        const initialSettings = profileHttp2Settings(profile);
        const conn = await connectHttp2({ transport: httpTransport, initialSettings });
        return { protocol: "http2", id: conn.id, conn };
    }
    // Default to HTTP/1.1 when ALPN is missing or selects http/1.1.
    const conn = await connectHttp1({ transport: httpTransport });
    return { protocol: "http1", id: conn.id, conn };
}

/** Resolve the effective profile id from options + client defaults. */
function resolveProfileId(options?: FetchOptions, defaults?: FetchClientOptions): ProfileId | undefined {
    return options?.profile ?? defaults?.profile;
}

/** Resolve the effective cookie jar from options + client defaults. */
function resolveCookieJar(options?: FetchOptions, defaults?: FetchClientOptions): CookieJar | undefined {
    return options?.cookieJar ?? defaults?.cookieJar;
}

/** Resolve the effective timeout from options + client defaults. */
function resolveTimeout(options?: FetchOptions, defaults?: FetchClientOptions): number {
    return options?.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/**
 * Create a {@link FetchClient} with the given defaults.
 *
 * The client owns a connection pool keyed by origin (host:port) and a cookie
 * jar that persists across requests. Connections are established lazily on
 * first use and reused for subsequent requests to the same origin.
 *
 * @example
 * ```ts
 * const client = await createClient({ profile: "chrome-140" });
 * const response = await client.fetch("https://example.com");
 * console.log(await response.text());
 * await client.close();
 * ```
 */
export function createClient(options?: FetchClientOptions): FetchClient {
    const id = createId("fetch") as FetchRequestId;
    const pool = new Map<PoolKey, PooledConnection>();
    const defaultJar: CookieJar = options?.cookieJar ?? createCookieJar();

    /** Look up a pooled connection for the given URL, or `undefined` if none. */
    function getPooled(url: ParsedUrl): PooledConnection | undefined {
        const key = poolKey(url);
        return pool.get(key);
    }

    /** Store a pooled connection for the given URL. */
    function setPooled(url: ParsedUrl, conn: PooledConnection): void {
        const key = poolKey(url);
        pool.set(key, conn);
        // (Re)start the idle TTL now that the connection is back in the pool.
        startIdleTimer(key);
    }

    /** Per-pool-key idle timers. One timer per pooled connection (FIX 4). */
    const idleTimers = new Map<PoolKey, ReturnType<typeof setTimeout>>();
    const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    /**
     * The underlying transport for each pooled connection, keyed by pool key.
     * The pooled connection object only exposes its protocol handle, so we
     * track the transport separately to be able to force-close it on timeout/
     * abort teardown (the connection's own graceful close() can deadlock
     * against an in-flight request waiting on an open transport).
     */
    const poolTransports = new Map<PoolKey, Transport>();

    /** Close a single pooled connection (protocol-aware), ignoring errors. */
    async function closePooled(pooled: PooledConnection): Promise<void> {
        switch (pooled.protocol) {
            case "http1":
                await pooled.conn.close({ kind: "client_close" });
                break;
            case "http2":
                await pooled.conn.close();
                break;
            default:
                assertNever(pooled);
        }
    }

    /**
     * Tear a connection down outside the normal request lifecycle — used by
     * the timeout and abort paths. We force-close the *transport* rather than
     * the connection's graceful close(): an HTTP/1.1 close() blocks until
     * in-flight requests drain, but a request whose peer never replies will
     * never drain while the transport stays open. Closing the transport
     * unblocks the request (its read rejects), letting teardown complete.
     */
    function teardown(key: PoolKey): void {
        clearIdleTimer(key);
        const transport = poolTransports.get(key);
        poolTransports.delete(key);
        pool.delete(key);
        if (transport !== undefined) {
            void transport.close();
        }
    }

    /** Evict one pooled connection: clear its timer, close it, drop it. */
    async function evict(key: PoolKey): Promise<void> {
        clearIdleTimer(key);
        poolTransports.delete(key);
        const pooled = pool.get(key);
        pool.delete(key);
        if (pooled !== undefined) {
            await closePooled(pooled);
        }
    }

    /** Clear (without resetting) the idle TTL for a pooled connection. */
    function clearIdleTimer(key: PoolKey): void {
        const existing = idleTimers.get(key);
        if (existing !== undefined) {
            clearTimeout(existing);
            idleTimers.delete(key);
        }
    }

    /**
     * Start (or reset) the idle TTL for a pooled connection. When the timer
     * fires the connection has been unused for `idleTimeoutMs`, so we evict it.
     * A borrowed connection has its timer cleared (see `getConnection`);
     * returning it to the pool restarts the timer (see `setPooled` and the
     * dispatch success path).
     */
    function startIdleTimer(key: PoolKey): void {
        if (idleTimeoutMs <= 0) {
            // Idle eviction disabled.
            return;
        }
        clearIdleTimer(key);
        idleTimers.set(
            key,
            setTimeout(() => {
                void evict(key);
            }, idleTimeoutMs),
        );
    }

    /** Close and evict every pooled connection. */
    async function drainPool(): Promise<void> {
        const entries = Array.from(pool.entries());
        pool.clear();
        poolTransports.clear();
        for (const timer of idleTimers.values()) {
            clearTimeout(timer);
        }
        idleTimers.clear();
        for (const [, pooled] of entries) {
            await closePooled(pooled);
        }
    }

    /** Get or establish a connection for the given URL + profile. */
    async function getConnection(
        url: ParsedUrl,
        profileId: ProfileId | undefined,
    ): Promise<PooledConnection> {
        const existing = getPooled(url);
        if (existing) {
            // The connection is now in use — stop its idle TTL so it is not
            // evicted mid-request. It is restarted when returned to the pool.
            clearIdleTimer(poolKey(url));
            return existing;
        }
        const profile = profileId ? getProfile(profileId) : undefined;
        // If no profile is specified, we still need a TLS config. Use a
        // minimal default that offers the standard cipher set.
        const effectiveProfile: BrowserProfile = profile ?? {
            id: "default" as ProfileId,
            name: "default",
            version: "0.0.0",
            tls: {
                cipherSuites: [
                    "TLS_AES_128_GCM_SHA256",
                    "TLS_AES_256_GCM_SHA384",
                    "TLS_CHACHA20_POLY1305_SHA256",
                ],
                extensionOrder: [0, 10, 11, 13, 16, 23, 27, 35, 43, 45, 51, 65281],
                supportedVersions: ["TLS 1.3", "TLS 1.2"],
                keyShareGroups: ["x25519", "secp256r1"],
                signatureAlgorithms: [
                    "ecdsa_secp256r1_sha256",
                    "rsa_pss_rsae_sha256",
                    "rsa_pkcs1_sha256",
                ],
                grease: false,
            },
            http2: {
                settings: {
                    headerTableSize: 65536,
                    enablePush: false,
                    maxConcurrentStreams: 100,
                    initialWindowSize: 6291456,
                    maxFrameSize: 16384,
                    maxHeaderListSize: 65536,
                },
                initialWindowSize: 6291456,
                maxFrameSize: 16384,
                headerTableSize: 65536,
                weight: 256,
            },
            http1: {
                defaultHeaders: {},
                headerOrder: [],
                connection: "keep-alive",
                acceptEncoding: "gzip, deflate, br",
            },
        };
        const key = poolKey(url);
        const { pooled, transport } = await (async (): Promise<{
            pooled: PooledConnection;
            transport: Transport;
        }> => {
            // Test seam: a caller-supplied factory yields a transport that
            // already speaks the HTTP layer's bytes (past any TLS the
            // production path would have applied). We connect HTTP/1.1
            // directly — the fake servers in tests speak HTTP/1.1.
            if (options?.transportFactory !== undefined) {
                const transport = await options.transportFactory(url.host, url.port);
                const conn = await connectHttp1({ transport });
                return { pooled: { protocol: "http1", id: conn.id, conn }, transport };
            }
            const transport = await connectTransport({
                host: url.host,
                port: url.port,
            });
            const established = await establishConnection(transport, effectiveProfile, url.host);
            if (established.protocol === "http2") {
                applyHttp2Profile(established.conn, effectiveProfile);
            }
            return { pooled: established, transport };
        })();
        poolTransports.set(key, transport);
        setPooled(url, pooled);
        return pooled;
    }

    /** Build the request header map from options + profile defaults. */
    function buildHeaders(
        url: ParsedUrl,
        opts: FetchOptions | undefined,
        profile: BrowserProfile | undefined,
    ): Map<string, string> {
        const headers = new Map<string, string>();
        if (profile) {
            applyHttp1Profile(headers, profile);
        }
        if (opts?.headers) {
            for (const [name, value] of Object.entries(opts.headers)) {
                headers.set(name, value);
            }
        }
        // Host is always derived from the URL unless explicitly overridden.
        if (!headers.has("host")) {
            headers.set("host", url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`);
        }
        return headers;
    }

    /** Apply cookie-jar cookies to the request headers. */
    function applyCookies(headers: Map<string, string>, jar: CookieJar, url: ParsedUrl): void {
        const cookies = jar.getCookies(cookieUrl(url));
        if (cookies.length === 0) {
            return;
        }
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        headers.set("cookie", cookieHeader);
    }

    /** Store response Set-Cookie headers into the jar. */
    function storeCookies(jar: CookieJar, headers: ReadonlyMap<string, string>, url: ParsedUrl): void {
        for (const raw of readSetCookie(headers)) {
            try {
                jar.setCookie(raw, cookieUrl(url));
            } catch (err) {
                // Domain-mismatch cookies are silently dropped — RFC 6265 §5.3
                // step 11 rejects them at the jar level, but a fetch client
                // should not fail the whole request for one bad cookie.
                if (err instanceof Error) {
                    // Swallow domain-mismatch errors; rethrow anything else.
                    if (!err.message.includes("domain")) {
                        throw err;
                    }
                }
            }
        }
    }

    /** Dispatch a single request (no redirect handling). */
    function dispatch(
        url: ParsedUrl,
        opts: FetchOptions | undefined,
    ): Promise<FetchResponse> {
        const profileId = resolveProfileId(opts, options);
        const timeoutMs = resolveTimeout(opts, options);
        const jar = resolveCookieJar(opts, options) ?? defaultJar;
        const profile = profileId ? getProfile(profileId) : undefined;
        const method = opts?.method ?? "GET";
        const headers = buildHeaders(url, opts, profile);
        applyCookies(headers, jar, url);
        const target = originString(url) + requestTarget(url);

        // The in-flight pooled connection, if one has been established. Both
        // the timeout and abort handlers tear it down, so they share this ref.
        let pooledRef: PooledConnection | undefined;
        let rejectDispatch: ((err: Error) => void) | undefined;
        let settled = false;

        /** Reject the dispatch exactly once, then tear down the connection. */
        const finishWithError = (err: Error): void => {
            if (settled) return;
            settled = true;
            if (pooledRef !== undefined) {
                // Force-close the transport to break any in-flight request
                // (the connection's graceful close() can deadlock — see
                // teardown()), then evict the connection from the pool.
                teardown(poolKey(url));
            }
            rejectDispatch?.(err);
        };

        const timeoutTimer = setTimeout(() => {
            // No-op until the dispatch promise exists; once it does, the timer
            // rejects it with a timeout error and tears down the connection.
            finishWithError(new FetchTimeoutError(timeoutMs));
        }, timeoutMs);

        // If the signal aborts while in-flight, cancel the request.
        const onAbort = (): void => {
            finishWithError(new FetchError("request aborted", { url: target }));
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });

        return new Promise<FetchResponse>((resolve, reject) => {
            rejectDispatch = reject;
            // Honor an already-aborted signal before dispatching. Doing this
            // inside the executor guarantees `rejectDispatch` is wired up.
            if (opts?.signal?.aborted) {
                clearTimeout(timeoutTimer);
                // The dispatch IIFE below never runs, so remove the abort
                // listener here to avoid leaking it on a discarded signal.
                opts.signal.removeEventListener("abort", onAbort);
                finishWithError(new FetchError("request aborted", { url: target }));
                return;
            }
            void (async (): Promise<void> => {
                try {
                    const pooled = await getConnection(url, profileId);
                    // A slow connect can race with a timeout/abort: if the
                    // dispatch already finished, don't dispatch on a stale
                    // connection — just hand it back to the pool.
                    if (settled) {
                        startIdleTimer(poolKey(url));
                        return;
                    }
                    pooledRef = pooled;
                    let response: FetchResponse;
                    switch (pooled.protocol) {
                        case "http1":
                            response = await dispatchHttp1(pooled.conn, url, method, headers, opts?.body);
                            break;
                        case "http2":
                            response = await dispatchHttp2(pooled.conn, url, method, headers, opts?.body);
                            break;
                        default:
                            assertNever(pooled);
                    }
                    // Store any Set-Cookie headers from the response.
                    const responseHeaders = new Map<string, string>();
                    for (const [k, v] of Object.entries(response.headers)) {
                        responseHeaders.set(k, v);
                    }
                    storeCookies(jar, responseHeaders, url);
                    if (settled) return;
                    settled = true;
                    // The connection is back in the pool (it was never
                    // evicted, since borrowing cleared its timer) — restart
                    // its idle TTL.
                    startIdleTimer(poolKey(url));
                    resolve(response);
                } catch (err) {
                    finishWithError(err instanceof Error ? err : new Error(String(err)));
                } finally {
                    clearTimeout(timeoutTimer);
                    opts?.signal?.removeEventListener("abort", onAbort);
                }
            })();
        });
    }

    /** Follow redirects for a response, returning the final response. */
    async function followRedirects(
        initialUrl: ParsedUrl,
        response: FetchResponse,
        opts: FetchOptions | undefined,
        redirectCount: number,
    ): Promise<FetchResponse> {
        const policy = resolveRedirectPolicy(opts, options?.redirectPolicy);
        switch (policy.kind) {
            case "manual":
                // Return the redirect response as-is — the caller handles it.
                return response;
            case "error":
                if (isRedirectStatus(response.status)) {
                    const location = response.headers["location"];
                    throw new RedirectError(
                        `redirect encountered with policy=error: ${response.status}`,
                        location !== undefined ? { location } : undefined,
                    );
                }
                return response;
            case "follow": {
                if (!isRedirectStatus(response.status)) {
                    return response;
                }
                if (redirectCount >= policy.maxRedirects) {
                    const location = response.headers["location"];
                    throw new RedirectError(
                        `redirect limit exceeded (${policy.maxRedirects})`,
                        location !== undefined ? { location } : undefined,
                    );
                }
                const location = response.headers["location"];
                if (location === undefined) {
                    // No Location header — return the redirect response as-is.
                    return response;
                }
                const nextUrl = resolveRedirectUrl(initialUrl, location);
                // 303 See Other: convert to GET and strip the body unless the
                // original method was HEAD or GET.
                let nextOpts: FetchOptions | undefined = opts;
                if (response.status === 303 && opts && BODY_STRIP_ON_303.has(opts.method ?? "GET")) {
                    // Build a new options object with body cleared. Under
                    // exactOptionalPropertyTypes, `body` must be absent, not
                    // `undefined`, so we construct a fresh object without it.
                    const { body: _body, ...rest } = opts;
                    void _body;
                    nextOpts = { ...rest, method: "GET" };
                }
                // Dispatch the redirected request. The cookie jar is shared,
                // so any Set-Cookie from the redirect response is already
                // stored.
                const nextResponse = await dispatch(nextUrl, nextOpts);
                return followRedirects(nextUrl, nextResponse, nextOpts, redirectCount + 1);
            }
            default:
                assertNever(policy);
        }
    }

    return {
        id,
        async fetch(input: string, opts?: FetchOptions): Promise<FetchResponse> {
            const url = parseUrl(input);
            const response = await dispatch(url, opts);
            return followRedirects(url, response, opts, 0);
        },
        async close(): Promise<void> {
            await drainPool();
            defaultJar.clear();
        },
    };
}

// --- Compression -------------------------------------------------------
// Body decompression delegates to @browsercore/compression (imported at the
// top of this file as `compression`), which implements browser-tolerant
// decoding — notably the zlib/raw `deflate` fallback. The reference oracle
// used in tests is `nodeZlib` from @browsercore/testing.

// --- 17-category browser-profile validation hooks ----------------------
// The @browsercore/testing package exports 17 test categories (see
// docs/TEST-SUITE.md). The fetch client participates in these categories:
//   - CookieBehavior: cookie jar round-trips Set-Cookie on responses.
//   - Compression: content-encoding negotiation + body decompression.
//   - RedirectHandling: follow/manual/error policies + loop detection.
//   - HeaderProfiles: profile-driven default headers + ordering.
//   - ErrorHandling: typed errors (FetchTimeoutError, RedirectError, etc.).
//   - ConnectionReuse: connection pooling across requests.
//   - SessionResumption: TLS session resumption (via @browsercore/tls).
//   - Regression: regression tests for fetch-level bugs.
//   - PerformanceBenchmarks: fetch-level throughput/latency benchmarks.
// Each category is validated by a vitest suite in @browsercore/testing; the
// fetch client's behavior is the system under test.

void assertNever;
