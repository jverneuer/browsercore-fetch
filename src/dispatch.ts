/**
 * Protocol dispatch for @browsercore/fetch.
 *
 * Per-protocol request encoding: takes a parsed URL + headers + body and drives
 * an {@link Http1Connection} or {@link Http2Connection} to produce a decoded
 * {@link FetchResponse}. Also owns {@link establishConnection}, the ALPN-driven
 * branch that lifts a TLS-terminated transport into a pooled protocol connection.
 */

// Connection-establishment + request dispatch composes every protocol layer.
/* eslint-disable import/max-dependencies */

import { connect as connectTransport } from "@browsercore/transport";
import type {
    CompressionProvider,
    CryptoProvider,
    EventProvider,
    Net,
    DnsResolver,
    Transport,
} from "@browsercore/contracts";
import { connectViaProxy, type ProxyConfig } from "@browsercore/proxy";
import { connectTls } from "@browsercore/tls";
import {
    connectHttp1,
    type HeaderCasing,
    type Http1Connection,
    type Http1ConnectionId,
    type HttpMethod,
    type HttpRequest,
} from "@browsercore/http1";
import { connectHttp2, type Http2Connection, type Http2Options } from "@browsercore/http2";
import type { BrowserProfile } from "@browsercore/profiles";
import { FetchError, wrapProxyError } from "./errors.js";
import { InternalEventEmitter } from "./internal-emitter.js";
import { proxyDialPlatform } from "./proxy.js";
import {
    ALPN_PROTOCOLS,
    profileHttp2Config,
    profileToTlsConfig,
} from "./profile.js";
import { adaptTlsToTransport } from "./tls-adapter.js";
import { bodyKind, buildResponse, readContentEncoding } from "./response.js";
import { defaultPort, originString, requestTarget } from "./url.js";
import type { FetchResponse, ParsedUrl } from "./types.js";

/** Set of HTTP methods the fetch surface accepts (exhaustive over FetchMethod). */
const FETCH_METHODS: ReadonlySet<string> = new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
]);

/** Validate a method string and narrow it to the http1 wire {@link HttpMethod}. */
function asHttpMethod(method: string): HttpMethod {
    if (!FETCH_METHODS.has(method)) {
        throw new FetchError(`unsupported HTTP method: ${method}`, { details: { method } });
    }
    // Every FetchMethod value is a valid HttpMethod (http1 additionally allows
    // TRACE/CONNECT, which fetch does not expose).
    return method as HttpMethod;
}

/**
 * A pooled protocol connection (HTTP/1.1 or HTTP/2). The protocol-specific
 * implementation is reachable through the `protocol` discriminant.
 */
export type PooledConnection =
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

/** Dispatch a request over an HTTP/1.1 connection. */
export async function dispatchHttp1(
    conn: Http1Connection,
    url: ParsedUrl,
    method: string,
    headers: Map<string, string>,
    body: Uint8Array | string | undefined,
    compression: CompressionProvider | undefined,
    /**
     * Header-name casing mode to apply on the wire (impersonation). When
     * omitted, the http1 layer applies its own default. Sourced from
     * {@link profileHttp1Config}.
     */
    headerCasing?: HeaderCasing,
): Promise<FetchResponse> {
    const wireHeaders = new Map(headers);
    if (!wireHeaders.has("host")) {
        wireHeaders.set(
            "host",
            url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`,
        );
    }
    // http1's serializer appends the body verbatim and leaves content-length
    // (or chunked transfer-encoding) to the caller. Without it the peer cannot
    // delimit the body, so leftover bytes bleed into the next keep-alive
    // request. Set content-length unless the caller supplied their own.
    if (body !== undefined && !wireHeaders.has("content-length") && !wireHeaders.has("transfer-encoding")) {
        const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
        wireHeaders.set("content-length", String(bodyBytes.length));
    }
    // Build the request with the impersonation casing threaded through. The
    // conditional spread keeps `headerCasing` absent (not `undefined`) when no
    // mode is supplied — required under exactOptionalPropertyTypes.
    const request: HttpRequest = {
        method: asHttpMethod(method),
        url: requestTarget(url),
        headers: wireHeaders,
        body: bodyKind(body),
        ...(headerCasing === undefined ? {} : { headerCasing }),
    };
    const response = await conn.request(request);
    // HTTP/1.1 decompresses the body in its `_decodeBody` based on the
    // `content-encoding` header — leave `encoding` unset so we don't
    // decompress twice.
    return buildResponse(
        originString(url) + requestTarget(url),
        response.statusCode,
        response.statusText,
        response.headers,
        response.body,
        undefined,
        compression,
    );
}

/** Dispatch a request over an HTTP/2 connection. */
export async function dispatchHttp2(
    conn: Http2Connection,
    url: ParsedUrl,
    method: string,
    headers: Map<string, string>,
    body: Uint8Array | string | undefined,
    compression: CompressionProvider | undefined,
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
        wireHeaders.set(
            ":authority",
            url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`,
        );
    }
    // RFC 9113 §8.3.6: `:authority` REPLACES the http/1.1 `host` header — no
    // browser sends `host` over h2, and nginx-based edges deterministically 400
    // a regular `host` header on an h2 request (live-confirmed WAF trigger).
    // buildHeaders adds `host` for the http/1.1 path (where it is required);
    // this is the single place it is stripped for the h2 wire. Applies even to
    // a caller-supplied `host` — the spec forbids the header on this protocol,
    // not just our auto-generated copy of it.
    wireHeaders.delete("host");
    const response = await conn.request({
        method,
        scheme: url.scheme,
        authority: url.port === defaultPort(url.scheme) ? url.host : `${url.host}:${url.port}`,
        path: requestTarget(url),
        headers: wireHeaders,
        body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    });
    // HTTP/2 does not touch content-encoding, so the body arrives still
    // compressed — decompress it here using the response's `content-encoding`.
    return buildResponse(
        originString(url) + requestTarget(url),
        response.statusCode,
        "",
        response.headers,
        response.body,
        readContentEncoding(response.headers),
        compression,
    );
}

/**
 * Establish a protocol connection (HTTP/1.1 or HTTP/2) over a TLS transport —
 * the `https:` branch of the dial path. ALPN picks the wire protocol; `http:`
 * targets never reach here (they go to
 * {@link establishHttp1OverTransport} instead — h2 is TLS-only in practice).
 *
 * `events` and `crypto` are injected — fetch never provides its own
 * EventProvider or CryptoProvider; browsersmith (the composition root) is
 * the sole source of both. No fallback.
 */
export async function establishConnection(
    transport: Transport,
    profile: BrowserProfile,
    serverName: string,
    events: EventProvider,
    crypto: CryptoProvider,
    compression: CompressionProvider | undefined,
): Promise<PooledConnection> {
    const tlsConfig = profileToTlsConfig(profile, serverName);
    const tls = await connectTls({
        transport,
        serverName,
        profile: tlsConfig,
        alpnProtocols: ALPN_PROTOCOLS,
        events,
        crypto,
        // RFC 8879: with a provider the ClientHello advertises
        // compress_certificate (27) and CompressedCertificate replies are
        // expanded; without one, the tls layer strips ext 27 itself.
        ...(compression === undefined ? {} : { compression }),
    });
    const alpn = tls.alpnProtocol;
    // Adapt the TLS connection to the Transport interface for the HTTP layer.
    // The adapter owns a private event bus, so no EventProvider is threaded
    // through here — close/error forwarded from the TLS connection land on the
    // adapter's private emitter, never the shared injected bus.
    const httpTransport = adaptTlsToTransport(tls);
    if (alpn === "h2") {
        // Seed the connection preface with the profile's full HTTP/2
        // configuration: SETTINGS values plus the impersonation vectors
        // (SETTINGS order, GREASE, connection WINDOW_UPDATE, pseudo-header
        // order, preface PRIORITY frames). The peer observes our advertised
        // limits AND our fingerprint shape from the first bytes.
        const h2config = profileHttp2Config(profile);
        const h2options: Http2Options = {
            transport: httpTransport,
            initialSettings: h2config.settings,
            settingsOrder: h2config.settingsOrder,
            settingsGrease: h2config.grease,
            // Absent (not `undefined`) when the profile carries no increment:
            // the http2 layer sends a connection WINDOW_UPDATE whenever the
            // option is present, and a zero increment is a wire violation
            // peers answer with GOAWAY (RFC 9113 §6.9 — the #79 failure).
            ...(h2config.connectionWindowUpdate === undefined
                ? {}
                : { connectionWindowUpdate: h2config.connectionWindowUpdate }),
            priorityFrames: h2config.priorityFrames,
            pseudoHeaderOrder: h2config.pseudoHeaderOrder,
            events,
            crypto,
        };
        const conn = await connectHttp2(h2options);
        // Settings are seeded into the connection preface via initialSettings
        // above; they cannot be mutated post-connect (see profile.ts).
        return { protocol: "http2", id: conn.id, conn };
    }
    // Default to HTTP/1.1 when ALPN is missing or selects http/1.1.
    // Thread the compression provider as the decompression backend: the
    // profile-driven `accept-encoding` default makes compressed http/1.1
    // responses the normal case, and http1 raises ContentEncodingError when
    // it has no provider to decode them with.
    const conn = await connectHttp1({
        transport: httpTransport,
        ...(compression === undefined ? {} : { decompressionProvider: compression }),
    });
    return { protocol: "http1", id: conn.id, conn };
}

/**
 * Establish an HTTP/1.1 connection directly over a plaintext transport — the
 * dial path for `http:` targets (#78: no TLS adapter, no ALPN) and for the
 * `transportFactory` test seam.
 *
 * `compression` is threaded exactly like the real TLS path does in
 * {@link establishConnection}: the resolved options/platform provider becomes
 * http1's `decompressionProvider`, so a gzip/deflate/br response decodes the
 * same way over both dial paths. When the provider is absent in both, it stays
 * absent here — http1 then raises ContentEncodingError on a compressed
 * response (same semantics as the real path without a provider) instead of
 * handing back corrupt bytes.
 */
export async function establishHttp1OverTransport(
    transport: Transport,
    compression: CompressionProvider | undefined,
): Promise<PooledConnection> {
    const conn = await connectHttp1({
        transport,
        ...(compression === undefined ? {} : { decompressionProvider: compression }),
    });
    return { protocol: "http1", id: conn.id, conn };
}

/**
 * Open a raw TCP transport to the parsed URL's host/port.
 *
 * `net`/`dns` are provided by the Platform object threaded through the
 * options chain (client → pool → dispatch). No fallback to a global
 * singleton — that would re-introduce a hard wire from fetch → transport.
 */
export function openTcpTransport(url: ParsedUrl, net: Net | undefined, dns: DnsResolver | undefined, events: EventProvider | undefined): Promise<Transport> {
    if (net === undefined || dns === undefined) {
        throw new FetchError(
            "openTcpTransport requires net and dns adapters. " +
                "Pass a Platform through FetchClientOptions so they flow down.",
        );
    }
    if (events === undefined) {
        throw new FetchError(
            "openTcpTransport requires an events provider. " +
                "Pass a Platform through FetchClientOptions so events flow down.",
        );
    }
    return connectTransport({ host: url.host, port: url.port, net, dns, events });
}

/**
 * Open a raw TCP transport for a PLAIN-HTTP target (#78).
 *
 * Same dial as {@link openTcpTransport} (same net/dns requirement and error
 * paths) except the transport is built with a PRIVATE event bus: a
 * TcpTransport's event surface IS the EventProvider it was constructed
 * with, and the plain-http path hands the transport directly to the HTTP/1.1
 * layer — on the shared platform bus, one connection's data/close events
 * would reach every http1 connection on that bus (cross-talk; a one-shot
 * client's close tore down another client's in-flight request). Same
 * rationale as the TLS adapter's private emitter (tls-adapter.ts).
 */
export function openPlainTcpTransport(url: ParsedUrl, net: Net | undefined, dns: DnsResolver | undefined): Promise<Transport> {
    return openTcpTransport(url, net, dns, new InternalEventEmitter());
}

/**
 * Open a transport to the parsed URL's host/port THROUGH a proxy.
 *
 * Dials the PROXY's host:port via the platform net adapter and lets
 * `connectViaProxy` run the scheme-appropriate tunnel (HTTP CONNECT, or
 * SOCKS5 with client-side DNS; SOCKS5h resolves on the proxy, so the origin
 * hostname is never resolved locally). The returned transport is the tunneled
 * stream — TLS layers over it end-to-end with the origin.
 *
 * Unlike {@link openTcpTransport} no `dns` is required up front: only the
 * `socks5` scheme resolves client-side, and the proxy dialer raises its own
 * typed error (mapped below) when a resolver it needs is absent. Proxy
 * failures are wrapped into {@link FetchProxyError} at this boundary with the
 * original `kind` preserved; other errors propagate unchanged.
 */
export async function openProxiedTransport(
    url: ParsedUrl,
    proxy: ProxyConfig,
    net: Net | undefined,
    dns: DnsResolver | undefined,
): Promise<Transport> {
    if (net === undefined) {
        throw new FetchError(
            "openProxiedTransport requires a net adapter. " +
                "Pass a Platform through FetchClientOptions so it flows down.",
        );
    }
    try {
        const tunneled = await connectViaProxy(
            proxy,
            { host: url.host, port: url.port },
            proxyDialPlatform(net, dns),
        );
        return tunneled;
    } catch (err) {
        throw wrapProxyError(err, { url: originString(url) });
    }
}
