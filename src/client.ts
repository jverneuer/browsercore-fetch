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

// Top-of-stack orchestrator: legitimately composes many internal modules.
/* eslint-disable import/max-dependencies */

import type { Transport } from "@browsercore/transport";
import type { Net, DnsResolver, Platform } from "@browsercore/contracts";
import { createCookieJar, CookieDomainError, type CookieJar } from "@browsercore/cookies";
import { getProfile, type BrowserProfile, type ProfileId } from "@browsercore/profiles";
import { AbortError, FetchTimeoutError, RedirectError, ensureFetchError } from "./errors.js";
import { dispatchHttp1, dispatchHttp2 } from "./dispatch.js";
import { createPool, type ConnectionPool, type PoolOptions } from "./pool.js";
import { applyHttp1Profile } from "./profile.js";
import { METHODS_PRESERVED_ON_303, isRedirectStatus, resolveRedirectPolicy } from "./redirect.js";
import { readSetCookie } from "./response.js";
import { assertNever, createId } from "./utils.js";
import { cookieUrl, defaultPort, originString, parseUrl, requestTarget, resolveRedirectUrl } from "./url.js";
import type {
    FetchOptions,
    FetchRequestId,
    FetchResponse,
    ParsedUrl,
    RedirectPolicy,
} from "./types.js";

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

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
     * Platform composition root. The single decoupled way to inject runtime
     * dependencies. When provided, `net`/`dns` default to
     * `platform.network.tcp`/`platform.network.dns` unless explicitly
     * overridden. No protocol-to-protocol hard wires.
     */
    readonly platform?: Platform;
    /**
     * Platform-provided TCP implementation. Injected from `platform` by
     * default; set this only to override a single adapter.
     */
    readonly net?: Net;
    /**
     * Platform-provided DNS resolver. Injected from `platform` by default;
     * set this only to override a single adapter.
     */
    readonly dns?: DnsResolver;
    /**
     * Test seam: override how the transport for an origin is established.
     * When provided, this is called instead of opening a real TCP transport +
     * TLS handshake. It must return a {@link Transport} that speaks the bytes
     * the HTTP layer expects on the *server* side of the connection (i.e.
     * already past any TLS the production path would have applied).
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

/** Resolve the effective profile id from options + client defaults. */
function resolveProfileId(options: FetchOptions | undefined, defaults: FetchClientOptions | undefined): ProfileId | undefined {
    return options?.profile ?? defaults?.profile;
}

/** Resolve the effective cookie jar from options + client defaults. */
function resolveCookieJar(options: FetchOptions | undefined, defaults: FetchClientOptions | undefined): CookieJar | undefined {
    return options?.cookieJar ?? defaults?.cookieJar;
}

/** Resolve the effective timeout from options + client defaults. */
function resolveTimeout(options: FetchOptions | undefined, defaults: FetchClientOptions | undefined): number {
    return options?.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/** A fallback profile used when no profile id is configured. */
function defaultProfile(): BrowserProfile {
    return {
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
    if (!headers.has("host")) {
        headers.set(
            "host",
            url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`,
        );
    }
    return headers;
}

/** Apply cookie-jar cookies to the request headers. */
function applyCookies(headers: Map<string, string>, jar: CookieJar, url: ParsedUrl): void {
    const cookies = jar.getCookies(cookieUrl(url));
    if (cookies.length === 0) {
        return;
    }
    headers.set("cookie", cookies.map((c) => `${c.name}=${c.value}`).join("; "));
}

/** Store response Set-Cookie headers into the jar. */
function storeCookies(jar: CookieJar, headers: ReadonlyMap<string, string>, url: ParsedUrl): void {
    for (const raw of readSetCookie(headers)) {
        try {
            jar.setCookie(raw, cookieUrl(url));
        } catch (err) {
            // Domain-mismatch cookies are silently dropped (RFC 6265 §5.3
            // step 11); anything else re-throws. The cookie jar throws a typed
            // CookieDomainError — match on that instead of parsing the message.
            if (err instanceof CookieDomainError) {
                continue;
            }
            throw err;
        }
    }
}

/**
 * Create a {@link FetchClient} with the given defaults.
 *
 * The client owns a connection pool keyed by origin (host:port) and a cookie
 * jar that persists across requests. Connections are established lazily on
 * first use and reused for subsequent requests to the same origin.
 */
export function createClient(options?: FetchClientOptions): FetchClient {
    const id = createId("fetch") as FetchRequestId;
    const defaultJar: CookieJar = options?.cookieJar ?? createCookieJar();
    // Resolve net/dns: explicit values win, then fall back to platform's
    // adapters. No global singleton — the composition root (browsersmith)
    // builds the Platform and passes it down through options.
    const resolvedNet = options?.net ?? options?.platform?.network.tcp;
    const resolvedDns = options?.dns ?? options?.platform?.network.dns;
    // Assemble pool options so absent optionals stay absent (exactOptionalPropertyTypes
    // rejects `{ idleTimeoutMs: undefined }` when the field is `idleTimeoutMs?: number`).
    const poolOptions: PoolOptions = {};
    if (options?.idleTimeoutMs !== undefined) {
        poolOptions.idleTimeoutMs = options.idleTimeoutMs;
    }
    if (resolvedNet !== undefined) {
        poolOptions.net = resolvedNet;
    }
    if (resolvedDns !== undefined) {
        poolOptions.dns = resolvedDns;
    }
    if (options?.transportFactory !== undefined) {
        poolOptions.transportFactory = options.transportFactory;
    }
    const pool: ConnectionPool = createPool(
        poolOptions,
        (profileId) => getProfile(profileId),
        defaultProfile(),
    );

    /** Dispatch a single request (no redirect handling). */
    const dispatch = (url: ParsedUrl, opts: FetchOptions | undefined): Promise<FetchResponse> => {
        const profileId = resolveProfileId(opts, options);
        const timeoutMs = resolveTimeout(opts, options);
        const jar = resolveCookieJar(opts, options) ?? defaultJar;
        const profile = profileId ? getProfile(profileId) : undefined;
        const method = opts?.method ?? "GET";
        const headers = buildHeaders(url, opts, profile);
        applyCookies(headers, jar, url);
        const target = originString(url) + requestTarget(url);

        let pooledRef: ReturnType<ConnectionPool["getConnection"]> extends Promise<infer R> ? R : never;
        let rejectDispatch: ((err: Error) => void) | undefined;
        let settled = false;

        /** Reject the dispatch exactly once, then tear down the connection. */
        const finishWithError = (err: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (pooledRef !== undefined) {
                pool.teardown(url);
            }
            rejectDispatch?.(err);
        };

        const timeoutTimer = setTimeout(() => {
            finishWithError(new FetchTimeoutError(timeoutMs));
        }, timeoutMs);

        const onAbort = (): void => {
            finishWithError(new AbortError("request aborted", { url: target }));
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });

        return new Promise<FetchResponse>((resolve, reject) => {
            rejectDispatch = reject;
            if (opts?.signal?.aborted === true) {
                clearTimeout(timeoutTimer);
                opts.signal.removeEventListener("abort", onAbort);
                finishWithError(new AbortError("request aborted", { url: target }));
                return;
            }
            void (async (): Promise<void> => {
                try {
                    const pooled = await pool.getConnection(url, profileId);
                    if (settled) {
                        pool.release(url);
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
                        /* istanbul ignore next: unreachable — pooled.protocol is "http1" | "http2" */
                        default:
                            assertNever(pooled);
                    }
                    const responseHeaders = new Map<string, string>();
                    for (const [k, v] of Object.entries(response.headers)) {
                        responseHeaders.set(k, v);
                    }
                    storeCookies(jar, responseHeaders, url);
                    // Unreachable: once dispatch resolves, this continuation runs
                    // as a single microtask through storeCookies + the check +
                    // resolve, so a timeout/abort (macrotask) cannot interleave
                    // and flip `settled` before we reach here.
                    /* istanbul ignore if */
                    if (settled) {
                        return;
                    }
                    settled = true;
                    pool.release(url);
                    resolve(response);
                } catch (err) {
                    finishWithError(ensureFetchError(err, { url: target }));
                } finally {
                    clearTimeout(timeoutTimer);
                    opts?.signal?.removeEventListener("abort", onAbort);
                }
            })();
        });
    };

    /** Follow redirects for a response, returning the final response. */
    const followRedirects = async (
        initialUrl: ParsedUrl,
        response: FetchResponse,
        opts: FetchOptions | undefined,
        redirectCount: number,
    ): Promise<FetchResponse> => {
        const policy = resolveRedirectPolicy(opts, options?.redirectPolicy);
        switch (policy.kind) {
            case "manual":
                return response;
            case "error":
                if (isRedirectStatus(response.status)) {
                    const location = response.headers["location"];
                    throw new RedirectError(
                        `redirect encountered with policy=error: ${response.status}`,
                        location === undefined ? undefined : { location },
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
                        location === undefined ? undefined : { location },
                    );
                }
                const location = response.headers["location"];
                if (location === undefined) {
                    return response;
                }
                const nextUrl = resolveRedirectUrl(initialUrl, location);
                // 303 See Other: convert to GET and strip the body unless the
                // original method was HEAD or GET (RFC 7231 §6.4.4).
                let nextOpts: FetchOptions | undefined = opts;
                const prevMethod = opts?.method ?? "GET";
                if (response.status === 303 && opts && !METHODS_PRESERVED_ON_303.has(prevMethod)) {
                    const { body: _body, ...rest } = opts;
                    void _body;
                    nextOpts = { ...rest, method: "GET" };
                }
                const nextResponse = await dispatch(nextUrl, nextOpts);
                return followRedirects(nextUrl, nextResponse, nextOpts, redirectCount + 1);
            }
            /* istanbul ignore next: unreachable — policy.kind is "manual" | "error" | "follow" */
            default:
                return assertNever(policy);
        }
    };

    return {
        id,
        async fetch(input: string, opts?: FetchOptions): Promise<FetchResponse> {
            const url = parseUrl(input);
            const response = await dispatch(url, opts);
            return followRedirects(url, response, opts, 0);
        },
        async close(): Promise<void> {
            await pool.drain();
            defaultJar.clear();
        },
    };
}
