/**
 * Connection pooling for @browsercore/fetch.
 *
 * A pool maps each origin (host:port) — plus the proxy identity when a
 * connection is tunneled — to at most one pooled protocol connection
 * (HTTP/1.1 or HTTP/2). Connections are established lazily on first use and
 * reused for subsequent requests to the same key. Each entry carries an idle
 * eviction timer: a connection unused for `idleTimeoutMs` is closed and dropped.
 *
 * The pool key includes the proxy (scheme/host/port + an opaque credentials
 * digest, see `poolKey`): two requests to the same origin through different
 * proxies — or with different credentials on the same proxy — never share a
 * connection, and a tunneled connection is never reused for another
 * origin/proxy pair.
 *
 * The pool also tracks the underlying transport per entry so a timed-out or
 * aborted request can force-close the transport directly (the connection's own
 * graceful `close()` blocks on in-flight requests, which would deadlock against
 * a peer that never replies).
 *
 * Server-initiated closes are evicted immediately: the pool subscribes to the
 * tracked transport's `close` event, and a close while the entry is still
 * pooled (the server or its LB dropped an idle connection) removes that entry,
 * so the next request dials fresh instead of failing on a dead connection.
 * A take whose transport is already dead (close event not yet processed)
 * discards the entry and redials transparently within the same take.
 */

import type { Transport } from "@browsercore/transport";
import type { CompressionProvider, EventProvider, Net, DnsResolver } from "@browsercore/contracts";
import type { CryptoProvider } from "@browsercore/crypto";
import type { ProxyConfig } from "@browsercore/proxy";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import { assertNever } from "./utils.js";
import { FetchError, wrapProxyError } from "./errors.js";
import {
    establishConnection,
    establishHttp1OverTransport,
    openProxiedTransport,
    openTcpTransport,
    type PooledConnection,
} from "./dispatch.js";
import { poolKey, type PoolKey } from "./url.js";
import type { ParsedUrl } from "./types.js";

/** Default pooled-connection idle eviction timeout in milliseconds. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Options for {@link createPool}. Fields are optional and mutable. */
export interface PoolOptions {
    /**
     * Platform event provider. Injected by the application entrypoint
     * (e.g. browsersmith passes its EventProvider). Required — fetch never
     * provides its own; the composition root is the sole source. No fallback.
     */
    events: EventProvider;
    /**
     * Idle pool eviction timeout in ms. A pooled connection that goes unused
     * for this duration is closed and evicted. Pass 0 to disable idle eviction.
     * Default 30_000.
     */
    idleTimeoutMs?: number;
    /**
     * Platform-provided TCP implementation. Injected by the application
     * entrypoint (e.g. browsersmith passes the Node adapter).
     */
    net?: Net;
    /**
     * Platform-provided DNS resolver. Injected by the application entrypoint
     * (e.g. browsersmith passes the Node adapter).
     */
    dns?: DnsResolver;
    /**
     * Platform compression provider. Injected by the application entrypoint.
     * Serves both dial paths: on the real-TLS path it carries RFC 8879
     * certificate compression (when present the ClientHello advertises
     * compress_certificate and CompressedCertificate replies are expanded,
     * when absent the tls layer strips the extension), and it is http1's
     * response-body decompression backend on every path — including the
     * `transportFactory` seam, which has no TLS to compress but still needs
     * gzip/deflate/br responses decoded.
     */
    compression?: CompressionProvider;
    /**
     * Platform crypto provider. Injected by the application entrypoint
     * (e.g. browsersmith passes `platform.crypto.provider`). Required for the
     * real-TCP path (TLS handshake + HTTP/2); the test seam (`transportFactory`)
     * bypasses it.
     */
    crypto?: CryptoProvider;
    /**
     * Test seam: override how the transport for an origin is established.
     * When provided, this is called instead of opening a real TCP transport +
     * TLS handshake. It must return a {@link Transport} that speaks the bytes
     * the HTTP layer expects on the *server* side of the connection.
     *
     * The factory replaces everything below the HTTP layer — TCP dial, TLS,
     * and (when a proxy is configured) the proxy tunnel. It therefore receives
     * the endpoint that is actually dialed: the PROXY's host/port when the
     * request is proxied, the origin's otherwise.
     */
    transportFactory?: (host: string, port: number) => Promise<Transport> | Transport;
}

/**
 * The connection pool surface the client orchestrates against. `release`
 * returns a borrowed connection to the pool (restarting its idle timer);
 * `teardown` force-closes the transport and evicts the entry.
 */
export interface ConnectionPool {
    /**
     * Get or establish a connection for the given URL + profile. When
     * `proxy` is set the connection is tunneled through it and pooled under
     * the origin+proxy key.
     */
    getConnection(url: ParsedUrl, profileId: ProfileId | undefined, proxy?: ProxyConfig): Promise<PooledConnection>;
    /** Return a borrowed connection to the pool (restart its idle timer). */
    release(url: ParsedUrl, proxy?: ProxyConfig): void;
    /** Force-close the transport for a pooled entry and evict it. */
    teardown(url: ParsedUrl, proxy?: ProxyConfig): void;
    /** Close and evict every pooled connection. */
    drain(): Promise<void>;
}

/**
 * Whether a tracked transport is still usable. A pooled entry's transport is
 * `"open"` while healthy; `"closed"` (remote close, error, timeout) or
 * `"closing"` means the entry is dead and must not be handed out.
 */
function isTransportOpen(transport: Transport | undefined): boolean {
    return transport !== undefined && transport.state.state === "open";
}

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
 * Create a {@link ConnectionPool}. `lookupProfile` is injected so the pool stays
 * decoupled from the profiles package's import path.
 */
export function createPool(
    options: PoolOptions,
    lookupProfile: (id: ProfileId) => BrowserProfile | undefined,
    fallbackProfile: BrowserProfile,
): ConnectionPool {
    const pool = new Map<PoolKey, PooledConnection>();
    const idleTimers = new Map<PoolKey, ReturnType<typeof setTimeout>>();
    /**
     * The underlying transport for each pooled connection, keyed by pool key.
     * Tracked separately from the pooled connection (which only exposes its
     * protocol handle) so a timed-out/aborted request can force-close it.
     */
    const poolTransports = new Map<PoolKey, Transport>();
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

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

    /**
     * Tear a connection down outside the normal request lifecycle — used by
     * the timeout and abort paths. We force-close the *transport* rather than
     * the connection's graceful close(): an HTTP/1.1 close() blocks until
     * in-flight requests drain, but a request whose peer never replies will
     * never drain while the transport stays open. Closing the transport
     * unblocks the request (its read rejects), letting teardown complete.
     */
    function teardownKey(key: PoolKey): void {
        clearIdleTimer(key);
        const transport = poolTransports.get(key);
        poolTransports.delete(key);
        pool.delete(key);
        if (transport !== undefined) {
            void transport.close();
        }
    }

    /**
     * Drop a dead pool entry: clear its idle timer and remove the entry +
     * its tracked transport, guarded by identity so a late trigger can never
     * remove a NEWER entry re-established under the same key. Two triggers:
     * the transport `close` watcher (server-initiated close while pooled) and
     * the take path (entry found dead at getConnection time).
     *
     * The protocol connection is deliberately NOT closed here: its transport
     * already died (the protocol layer tears itself down on transport close),
     * and a graceful close() would block on in-flight requests we want to
     * fail fast. Dropping the entry makes it unreachable; GC reclaims it once
     * any in-flight dispatch has settled.
     */
    function discardDeadEntry(key: PoolKey, transport: Transport | undefined, pooled: PooledConnection): void {
        clearIdleTimer(key);
        if (poolTransports.get(key) === transport) {
            poolTransports.delete(key);
        }
        if (pool.get(key) === pooled) {
            pool.delete(key);
        }
    }

    /**
     * Evict an entry whose transport closed. This is the server-initiated
     * close path (LB idle timeout, h2 GOAWAY followed by FIN, RST): the close
     * fires while the entry is still pooled and no request of ours is in
     * flight to notice, so without this watcher the dead entry survives until
     * the next request takes it and fails. Client-initiated closes (idle
     * eviction, teardown, drain) delete the entry BEFORE their close event
     * fires — the identity guard in {@link discardDeadEntry} turns those
     * events into no-ops, leaving their semantics unchanged.
     */
    function watchTransportClose(key: PoolKey, transport: Transport, pooled: PooledConnection): void {
        transport.on("close", () => {
            discardDeadEntry(key, transport, pooled);
        });
    }

    /**
     * Establish + pool a new connection, returning it. The transport is opened
     * exactly once and reused for both the protocol handshake and the
     * pool's own transport map (so teardown can force-close the same socket).
     *
     * Three establishment paths:
     * - `transportFactory` set (test seam) — the factory replaces everything
     *   below the HTTP layer, so it receives the dialed endpoint (the proxy's
     *   when proxied) and its transport goes straight to HTTP/1.1.
     * - direct real path — TCP to the origin, then TLS.
     * - proxied real path — `openProxiedTransport` dials the proxy and
     *   tunnels; TLS is then established END-TO-END with the origin over the
     *   tunneled stream (same `establishConnection` as the direct path).
     */
    async function establishAndStore(url: ParsedUrl, profile: BrowserProfile, proxy: ProxyConfig | undefined): Promise<PooledConnection> {
        const key = poolKey(url, proxy);
        let transport: Transport;
        let pooled: PooledConnection;
        if (options.transportFactory !== undefined) {
            // Test seam: a caller-supplied factory yields a transport that
            // already speaks the HTTP layer's bytes (past any TLS — and any
            // proxy tunnel — the production path would have applied). Fake
            // servers in tests speak HTTP/1.1. The compression provider is
            // threaded with the same options/platform resolution the real
            // path's establishConnection consumes, so compressed responses
            // decode identically over both dial paths.
            const dialed = proxy === undefined ? { host: url.host, port: url.port } : { host: proxy.host, port: proxy.port };
            try {
                transport = await options.transportFactory(dialed.host, dialed.port);
            } catch (err) {
                // The seam stands in for the proxy dial, so proxy-shaped
                // failures raised here get the same typed wrapping as the
                // real path would apply; anything else propagates unchanged.
                throw wrapProxyError(err);
            }
            pooled = await establishHttp1OverTransport(transport, options.compression);
        } else if (proxy === undefined) {
            // establishConnection applies the profile's HTTP/2 settings to the
            // connection when ALPN negotiates h2 — no separate step needed here.
            // net/dns/events/crypto come from Platform, threaded through
            // client → pool. openTcpTransport throws a clear error when net/dns
            // are missing, so let it run first to preserve that error path.
            transport = await openTcpTransport(url, options.net, options.dns, options.events);
            // crypto is required for the real-TCP path (TLS handshake + HTTP/2):
            // throw a clear error if it is missing rather than failing later in
            // the handshake with a confusing "crypto undefined" message.
            if (options.crypto === undefined) {
                throw new FetchError(
                    "createPool requires a crypto provider for the real-TCP path. " +
                        "Pass crypto via PoolOptions or provide a Platform.",
                );
            }
            pooled = await establishConnection(transport, profile, url.host, options.events, options.crypto, options.compression);
        } else {
            // openProxiedTransport throws a clear error when the net adapter
            // is missing and wraps proxy-handshake failures, so let it run
            // before the crypto guard to preserve those error paths.
            transport = await openProxiedTransport(url, proxy, options.net, options.dns);
            if (options.crypto === undefined) {
                throw new FetchError(
                    "createPool requires a crypto provider for the proxied path. " +
                        "Pass crypto via PoolOptions or provide a Platform.",
                );
            }
            // TLS terminates at the ORIGIN, not the proxy — serverName stays
            // the origin host and the handshake runs over the tunneled stream.
            pooled = await establishConnection(transport, profile, url.host, options.events, options.crypto, options.compression);
        }
        poolTransports.set(key, transport);
        pool.set(key, pooled);
        // The tracked transport is the bottom of this entry's stack (raw TCP,
        // tunneled proxy stream, or the test-seam factory transport) — the
        // layer that observes the server closing the socket.
        watchTransportClose(key, transport, pooled);
        startIdleTimer(key);
        return pooled;
    }

    return {
        async getConnection(url, profileId, proxy): Promise<PooledConnection> {
            const key = poolKey(url, proxy);
            const existing = pool.get(key);
            if (existing !== undefined) {
                const transport = poolTransports.get(key);
                if (isTransportOpen(transport)) {
                    // The connection is now in use — stop its idle TTL so it is not
                    // evicted mid-request. It is restarted when returned to the pool.
                    clearIdleTimer(key);
                    return existing;
                }
                // Dead entry: the server closed the connection between release
                // and this take and the close event has not been processed yet
                // (or was lost). Discard it and dial fresh below — the caller
                // gets one transparent redial inside the SAME take and never
                // sees the dead connection. No await has run since the pool.get
                // above, so this discard cannot race another pool mutation.
                discardDeadEntry(key, transport, existing);
            }
            const profile = profileId ? (lookupProfile(profileId) ?? fallbackProfile) : fallbackProfile;
            const pooled = await establishAndStore(url, profile, proxy);
            return pooled;
        },
        release(url: ParsedUrl, proxy?: ProxyConfig): void {
            startIdleTimer(poolKey(url, proxy));
        },
        teardown(url: ParsedUrl, proxy?: ProxyConfig): void {
            teardownKey(poolKey(url, proxy));
        },
        async drain(): Promise<void> {
            const entries = Array.from(pool.entries());
            pool.clear();
            poolTransports.clear();
            for (const timer of idleTimers.values()) {
                clearTimeout(timer);
            }
            idleTimers.clear();
            await Promise.all(entries.map(([, pooled]) => closePooled(pooled)));
        },
    };
}
