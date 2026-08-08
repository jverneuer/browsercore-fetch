/**
 * Connection pooling for @browsercore/fetch.
 *
 * A pool maps each origin (host:port) to at most one pooled protocol connection
 * (HTTP/1.1 or HTTP/2). Connections are established lazily on first use and
 * reused for subsequent requests to the same origin. Each entry carries an idle
 * eviction timer: a connection unused for `idleTimeoutMs` is closed and dropped.
 *
 * The pool also tracks the underlying transport per entry so a timed-out or
 * aborted request can force-close the transport directly (the connection's own
 * graceful `close()` blocks on in-flight requests, which would deadlock against
 * a peer that never replies).
 */

import type { Transport } from "@browsercore/transport";
import type { Net, DnsResolver } from "@browsercore/contracts";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import { assertNever } from "./utils.js";
import {
    establishConnection,
    establishHttp1OverTransport,
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
     * Test seam: override how the transport for an origin is established.
     * When provided, this is called instead of opening a real TCP transport +
     * TLS handshake. It must return a {@link Transport} that speaks the bytes
     * the HTTP layer expects on the *server* side of the connection.
     */
    transportFactory?: (host: string, port: number) => Promise<Transport> | Transport;
}

/**
 * The connection pool surface the client orchestrates against. `release`
 * returns a borrowed connection to the pool (restarting its idle timer);
 * `teardown` force-closes the transport and evicts the entry.
 */
export interface ConnectionPool {
    /** Get or establish a connection for the given URL + profile. */
    getConnection(url: ParsedUrl, profileId: ProfileId | undefined): Promise<PooledConnection>;
    /** Return a borrowed connection to the pool (restart its idle timer). */
    release(url: ParsedUrl): void;
    /** Force-close the transport for an origin and evict it from the pool. */
    teardown(url: ParsedUrl): void;
    /** Close and evict every pooled connection. */
    drain(): Promise<void>;
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
     * Establish + pool a new connection, returning it. The transport is opened
     * exactly once and reused for both the protocol handshake and the
     * pool's own transport map (so teardown can force-close the same socket).
     */
    async function establishAndStore(url: ParsedUrl, profile: BrowserProfile): Promise<PooledConnection> {
        const key = poolKey(url);
        let transport: Transport;
        let pooled: PooledConnection;
        if (options.transportFactory === undefined) {
            // establishConnection applies the profile's HTTP/2 settings to the
            // connection when ALPN negotiates h2 — no separate step needed here.
            // openTcpTransport falls back to requireDeps() when net/dns are
            // omitted, so this works with top-level fetch() that never injected
            // adapters as long as setConnectorDeps() was called at startup.
            transport = await openTcpTransport(url, options.net, options.dns);
            pooled = await establishConnection(transport, profile, url.host);
        } else {
            // Test seam: a caller-supplied factory yields a transport that
            // already speaks the HTTP layer's bytes (past any TLS the
            // production path would have applied). Fake servers in tests
            // speak HTTP/1.1.
            transport = await options.transportFactory(url.host, url.port);
            pooled = await establishHttp1OverTransport(transport);
        }
        poolTransports.set(key, transport);
        pool.set(key, pooled);
        startIdleTimer(key);
        return pooled;
    }

    return {
        async getConnection(url, profileId): Promise<PooledConnection> {
            const key = poolKey(url);
            const existing = pool.get(key);
            if (existing) {
                // The connection is now in use — stop its idle TTL so it is not
                // evicted mid-request. It is restarted when returned to the pool.
                clearIdleTimer(key);
                return existing;
            }
            const profile = profileId ? (lookupProfile(profileId) ?? fallbackProfile) : fallbackProfile;
            const pooled = await establishAndStore(url, profile);
            return pooled;
        },
        release(url: ParsedUrl): void {
            startIdleTimer(poolKey(url));
        },
        teardown(url: ParsedUrl): void {
            teardownKey(poolKey(url));
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
