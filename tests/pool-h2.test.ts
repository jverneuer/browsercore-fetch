/**
 * Tests for pool.ts branches not exercised by pool.test.ts:
 *   1. The http2 branch of closePooled (line 81) — drain() closing an h2 connection.
 *   2. The assertNever default branch of closePooled (line 84).
 *   3. The net/dns error path in establishAndStore (lines 175-181).
 *   4. The production path (openTcpTransport + establishConnection, lines 182-183).
 *
 * The existing pool.test.ts only exercises http1 pooled connections (via the
 * transportFactory seam). This file mocks the dispatch module so the pool
 * establishes an http2 pooled connection, then verifies drain() closes it
 * through the http2 branch of closePooled.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";

// ---------------------------------------------------------------------------
// Top-level mock for dispatch.js: establishHttp1OverTransport returns an http2
// pooled connection so the pool's http2 close path is exercised. The other
// exports are stubbed so they can be given return values per-test.
// ---------------------------------------------------------------------------

// Hoist the mock function above the vi.mock factory (which is hoisted to the
// top of the file) so it is initialized before the factory runs.
const h2Closed = vi.hoisted(() => vi.fn());

vi.mock("../src/dispatch.js", () => ({
    establishConnection: vi.fn(),
    establishHttp1OverTransport: vi.fn().mockResolvedValue({
        protocol: "http2" as const,
        id: "h2-pool-test",
        conn: { id: "h2-pool-test", close: h2Closed },
    }),
    openPlainTcpTransport: vi.fn(),
    openProxiedTransport: vi.fn(),
    openTcpTransport: vi.fn(),
}));

// Import AFTER the mock is registered.
// eslint-disable-next-line import/first
import { createPool } from "../src/pool.js";
// eslint-disable-next-line import/first
import { parseUrl } from "../src/url.js";
// eslint-disable-next-line import/first
import {
    establishConnection,
    establishHttp1OverTransport,
    openPlainTcpTransport,
    openProxiedTransport,
    openTcpTransport,
} from "../src/dispatch.js";
import type { ParsedUrl } from "../src/types.js";

class StubTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    public closed = false;
    constructor(id = "t") {
        super();
        this.id = id as TransportId;
    }
    public get state(): TransportState {
        return this.closed ? { state: "closed", reason: { kind: "client_close" } } : { state: "open" };
    }
    public write(): Promise<void> {
        return Promise.resolve();
    }
    public read(): Promise<Uint8Array> {
        // Never resolves; no dispatch happens in these tests.
        return new Promise(() => {});
    }
    public close(): Promise<void> {
        this.closed = true;
        this.emit("close", false);
        return Promise.resolve();
    }
}

function fallbackProfile(): BrowserProfile {
    return {
        id: "default" as ProfileId,
        name: "default",
        version: "0.0.0",
        tls: {
            cipherSuites: [],
            extensionOrder: [],
            supportedVersions: [],
            keyShareGroups: [],
            signatureAlgorithms: [],
            grease: false,
        },
        http2: {
            settings: {},
            initialWindowSize: 65535,
            maxFrameSize: 16384,
            headerTableSize: 4096,
            weight: 16,
        },
        http1: {
            defaultHeaders: {},
            headerOrder: [],
            connection: "keep-alive",
            acceptEncoding: "gzip",
        },
    };
}

const lookup = (_id: ProfileId): BrowserProfile | undefined => undefined;

function url(s: string): ParsedUrl {
    return parseUrl(s);
}

describe("pool — http2 close path", () => {
    it("closes an http2 pooled connection through the http2 branch on drain", async () => {
        h2Closed.mockReset();
        const factory = (): Transport => new StubTransport("h2-factory");
        const pool = createPool({ transportFactory: factory }, lookup, fallbackProfile());
        try {
            const conn = await pool.getConnection(url("http://example.com/"), undefined);
            expect(conn.protocol).toBe("http2");
            await pool.drain();
            // The http2 branch of closePooled called conn.close() (no args).
            expect(h2Closed).toHaveBeenCalledTimes(1);
        } finally {
            h2Closed.mockReset();
        }
    });

    it("drain closes multiple http2 pooled connections across origins", async () => {
        h2Closed.mockReset();
        const factory = (): Transport => new StubTransport();
        const pool = createPool({ transportFactory: factory }, lookup, fallbackProfile());
        try {
            await pool.getConnection(url("http://a.example/"), undefined);
            await pool.getConnection(url("http://b.example/"), undefined);
            await pool.drain();
            // Both http2 connections were closed via the http2 branch.
            expect(h2Closed).toHaveBeenCalledTimes(2);
        } finally {
            h2Closed.mockReset();
        }
    });

    it("hits the assertNever default branch for an unknown protocol", async () => {
        // Force the pool to store a pooled connection whose protocol is neither
        // "http1" nor "http2". closePooled's switch falls through to the
        // default branch, which calls assertNever (a runtime error).
        const closed = vi.fn();
        establishHttp1OverTransport.mockResolvedValueOnce({
            // "http3" is not a valid PooledConnection protocol — this is the
            // only way to exercise the exhaustiveness check at runtime.
            protocol: "http3" as never,
            id: "bad",
            conn: { id: "bad", close: closed },
        });
        const factory = (): Transport => new StubTransport();
        const pool = createPool({ transportFactory: factory }, lookup, fallbackProfile());
        await pool.getConnection(url("http://example.com/"), undefined);
        // drain() calls closePooled -> assertNever throws.
        await expect(pool.drain()).rejects.toThrow();
        expect(closed).not.toHaveBeenCalled();
    });
});

describe("pool — adapter error path", () => {
    // The pool forwards options.net/options.dns to openTcpTransport. When
    // adapters are missing, openTcpTransport throws a typed error. The pool
    // must propagate that error — not swallow it. These tests pin that
    // propagation for each "missing adapters" shape.

    it("propagates the error when no adapters are provided", async () => {
        // No transportFactory, no net, no dns: openTcpTransport throws.
        // The pool must surface it, not swallow it.
        openTcpTransport.mockReset();
        openTcpTransport.mockRejectedValueOnce(
            new Error("openTcpTransport requires net and dns adapters."),
        );

        const pool = createPool({}, lookup, fallbackProfile());
        await expect(pool.getConnection(url("https://example.com/"), undefined)).rejects.toThrow(
            "openTcpTransport requires net and dns adapters",
        );
        expect(openTcpTransport).toHaveBeenCalledTimes(1);
        openTcpTransport.mockReset();
    });

    it("propagates the error when only net is provided (dns missing)", async () => {
        // net without dns: openTcpTransport throws. Same propagation contract.
        openTcpTransport.mockReset();
        openTcpTransport.mockRejectedValueOnce(new Error("dns adapter missing"));

        const net = { connect: vi.fn() } as never;
        const pool = createPool({ net }, lookup, fallbackProfile());
        await expect(pool.getConnection(url("https://example.com/"), undefined)).rejects.toThrow(
            "dns adapter missing",
        );
        expect(openTcpTransport).toHaveBeenCalledTimes(1);
        openTcpTransport.mockReset();
    });

    it("propagates the error when only dns is provided (net missing)", async () => {
        openTcpTransport.mockReset();
        openTcpTransport.mockRejectedValueOnce(new Error("net adapter missing"));

        const dns = { resolve: vi.fn() } as never;
        const pool = createPool({ dns }, lookup, fallbackProfile());
        await expect(pool.getConnection(url("https://example.com/"), undefined)).rejects.toThrow(
            "net adapter missing",
        );
        expect(openTcpTransport).toHaveBeenCalledTimes(1);
        openTcpTransport.mockReset();
    });

    it("propagates the plain-http dial's error (http targets use openPlainTcpTransport)", async () => {
        openPlainTcpTransport.mockReset();
        openPlainTcpTransport.mockRejectedValueOnce(new Error("plain dial adapters missing"));
        const pool = createPool({}, lookup, fallbackProfile());
        await expect(pool.getConnection(url("http://example.com/"), undefined)).rejects.toThrow(
            "plain dial adapters missing",
        );
        expect(openPlainTcpTransport).toHaveBeenCalledTimes(1);
        // The shared-bus dial was not consulted for a plain-http target.
        expect(openTcpTransport).not.toHaveBeenCalled();
        openPlainTcpTransport.mockReset();
    });
});

describe("pool — production path (real net/dns)", () => {
    it("opens a transport and establishes a TLS connection when net and dns are provided", async () => {
        // Provide net + dns (no transportFactory) so establishAndStore takes
        // the production https path: openTcpTransport -> establishConnection.
        const fakeTransport = new StubTransport("prod-transport");
        const prodClosed = vi.fn();
        openTcpTransport.mockResolvedValueOnce(fakeTransport);
        establishConnection.mockResolvedValueOnce({
            protocol: "http1" as const,
            id: "prod-conn",
            conn: { id: "prod-conn", close: prodClosed },
        });

        const net = { connect: vi.fn() } as never;
        const dns = { resolve: vi.fn() } as never;
        // crypto is required for the real-TCP path (TLS handshake); the lower
        // layers are mocked here, so a stub provider suffices.
        const crypto = { randomBytes: vi.fn() } as never;
        const pool = createPool({ net, dns, crypto }, lookup, fallbackProfile());
        try {
            const conn = await pool.getConnection(url("https://example.com/"), undefined);
            expect(conn.protocol).toBe("http1");
            // openTcpTransport was called with the url, net, dns.
            expect(openTcpTransport).toHaveBeenCalledTimes(1);
            // establishConnection was called with the transport, profile, host.
            expect(establishConnection).toHaveBeenCalledTimes(1);
            await pool.drain();
            expect(prodClosed).toHaveBeenCalledTimes(1);
        } finally {
            openTcpTransport.mockReset();
            establishConnection.mockReset();
        }
    });

    it("throws a clear error when crypto is missing on the direct https path", async () => {
        openTcpTransport.mockReset();
        openTcpTransport.mockResolvedValueOnce(new StubTransport("direct"));
        const net = { connect: vi.fn() } as never;
        const dns = { resolve: vi.fn() } as never;
        const pool = createPool({ net, dns }, lookup, fallbackProfile());
        // https still demands a crypto provider (TLS handshake); #78 relaxes
        // the requirement for plain http only.
        await expect(pool.getConnection(url("https://example.com/"), undefined)).rejects.toThrow(
            "crypto provider",
        );
        openTcpTransport.mockReset();
    });

    it("plain http: dials TCP and goes straight to HTTP/1.1 — no TLS, no ALPN (#78)", async () => {
        // An http: URL on the direct path must never reach the TLS layer: the
        // transport goes directly to establishHttp1OverTransport. Before #78
        // the pool TLS-wrapped every scheme and plaintext targets failed with
        // TLS record decryption errors.
        openPlainTcpTransport.mockReset();
        establishHttp1OverTransport.mockReset();
        establishHttp1OverTransport.mockResolvedValue({
            protocol: "http1" as const,
            id: "seam-default",
            conn: { id: "seam-default", close: vi.fn() },
        });
        establishConnection.mockReset();
        const fakeTransport = new StubTransport("plain-transport");
        const plainClosed = vi.fn();
        openPlainTcpTransport.mockResolvedValueOnce(fakeTransport);
        establishHttp1OverTransport.mockResolvedValueOnce({
            protocol: "http1" as const,
            id: "plain-conn",
            conn: { id: "plain-conn", close: plainClosed },
        });

        const net = { connect: vi.fn() } as never;
        const dns = { resolve: vi.fn() } as never;
        const compression = {} as never;
        // Deliberately NO crypto: plain http must not require it.
        const pool = createPool({ net, dns, compression }, lookup, fallbackProfile());
        try {
            const conn = await pool.getConnection(url("http://example.com/"), undefined);
            expect(conn.protocol).toBe("http1");
            // The plaintext dial (private-bus TCP, see openPlainTcpTransport):
            // transport + compression provider threaded to h1 directly.
            expect(openPlainTcpTransport).toHaveBeenCalledTimes(1);
            expect(establishHttp1OverTransport).toHaveBeenCalledTimes(1);
            expect(establishHttp1OverTransport).toHaveBeenCalledWith(fakeTransport, compression);
            // The TLS dial + path were never taken.
            expect(openTcpTransport).not.toHaveBeenCalled();
            expect(establishConnection).not.toHaveBeenCalled();
            await pool.drain();
            expect(plainClosed).toHaveBeenCalledTimes(1);
        } finally {
            openPlainTcpTransport.mockReset();
            establishHttp1OverTransport.mockReset();
        }
    });
});

describe("pool — proxied production path (real dial + TLS over the tunnel)", () => {
    const proxy = { scheme: "http" as const, host: "proxy.example", port: 8080 };

    it("dials via openProxiedTransport and establishes TLS over the TUNNELED transport", async () => {
        const tunneled = new StubTransport("tunneled");
        const proxiedClosed = vi.fn();
        openProxiedTransport.mockResolvedValueOnce(tunneled);
        establishConnection.mockResolvedValueOnce({
            protocol: "http1" as const,
            id: "proxied-conn",
            conn: { id: "proxied-conn", close: proxiedClosed },
        });

        const net = { connect: vi.fn() } as never;
        const dns = { resolve: vi.fn() } as never;
        const crypto = { randomBytes: vi.fn() } as never;
        const pool = createPool({ net, dns, crypto }, lookup, fallbackProfile());
        try {
            const target = url("https://example.com/");
            const conn = await pool.getConnection(target, undefined, proxy);
            expect(conn.protocol).toBe("http1");
            // The proxy dialer received the url, proxy, net, dns — and NOT the
            // events provider (the proxy dial path consumes none).
            expect(openProxiedTransport).toHaveBeenCalledTimes(1);
            expect(openProxiedTransport).toHaveBeenCalledWith(target, proxy, net, dns);
            // TLS was established OVER the tunneled transport with the ORIGIN
            // as serverName — the tunnel is transparent to the TLS layer.
            expect(establishConnection).toHaveBeenCalledTimes(1);
            expect(establishConnection.mock.calls[0]?.[0]).toBe(tunneled);
            expect(establishConnection.mock.calls[0]?.[2]).toBe("example.com");
            await pool.drain();
            expect(proxiedClosed).toHaveBeenCalledTimes(1);
        } finally {
            openProxiedTransport.mockReset();
            establishConnection.mockReset();
        }
    });

    it("throws a clear error when crypto is missing on the proxied path", async () => {
        openProxiedTransport.mockResolvedValueOnce(new StubTransport("tunneled"));
        const net = { connect: vi.fn() } as never;
        const dns = { resolve: vi.fn() } as never;
        const pool = createPool({ net, dns }, lookup, fallbackProfile());
        await expect(pool.getConnection(url("https://example.com/"), undefined, proxy)).rejects.toThrow(
            "crypto provider",
        );
        openProxiedTransport.mockReset();
    });

    it("tunnels a plain http: target first, then speaks plaintext HTTP/1.1 over the tunnel (#78)", async () => {
        // Proxied http: URLs keep the CONNECT tunnel (and the origin+proxy
        // pool key), but the tunneled stream goes straight to HTTP/1.1 — TLS
        // never applies to an http: origin, and no crypto provider is needed.
        openProxiedTransport.mockReset();
        establishHttp1OverTransport.mockReset();
        establishHttp1OverTransport.mockResolvedValue({
            protocol: "http1" as const,
            id: "seam-default",
            conn: { id: "seam-default", close: vi.fn() },
        });
        establishConnection.mockReset();
        const tunneled = new StubTransport("tunneled-plain");
        const plainClosed = vi.fn();
        openProxiedTransport.mockResolvedValueOnce(tunneled);
        establishHttp1OverTransport.mockResolvedValueOnce({
            protocol: "http1" as const,
            id: "proxied-plain-conn",
            conn: { id: "proxied-plain-conn", close: plainClosed },
        });

        const net = { connect: vi.fn() } as never;
        const dns = { resolve: vi.fn() } as never;
        const compression = {} as never;
        const pool = createPool({ net, dns, compression }, lookup, fallbackProfile());
        try {
            const conn = await pool.getConnection(url("http://example.com/"), undefined, proxy);
            expect(conn.protocol).toBe("http1");
            expect(openProxiedTransport).toHaveBeenCalledTimes(1);
            // Plaintext h1 over the TUNNELED stream, with the compression
            // provider threaded like every other dial path.
            expect(establishHttp1OverTransport).toHaveBeenCalledTimes(1);
            expect(establishHttp1OverTransport).toHaveBeenCalledWith(tunneled, compression);
            // TLS was never established over the tunnel.
            expect(establishConnection).not.toHaveBeenCalled();
            await pool.drain();
            expect(plainClosed).toHaveBeenCalledTimes(1);
        } finally {
            openProxiedTransport.mockReset();
            establishHttp1OverTransport.mockReset();
        }
    });
});
