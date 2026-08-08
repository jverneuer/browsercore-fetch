/**
 * Regression tests for Bug 2 — adapter injection via Platform.
 *
 * Bug: top-level `fetch()` threw "FetchClient requires net and dns adapters"
 * because adapters were never threaded from the composition root down to the
 * transport layer. The WRONG fix (a `requireDeps()` fallback in
 * `openTcpTransport`) created a hard wire from fetch → transport's global
 * singleton — a steel chain from the top of the stack to the bottom.
 *
 * The RIGHT fix: adapters flow from Platform through the options chain
 * (client → pool → dispatch). `openTcpTransport` takes net/dns explicitly and
 * throws a typed error if they are missing — no global fallback.
 *
 * Contracts covered:
 *   1. `openTcpTransport(url, net, dns)` uses provided adapters directly.
 *   2. `openTcpTransport(url)` without adapters throws FetchError.
 *   3. Pool with net/dns from Platform establishes connections.
 *   4. Pool without adapters surfaces a typed error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { vi as vitestVi } from "vitest";
import { EventEmitter } from "node:events";
import type { Net, DnsResolver, Platform } from "@browsercore/contracts";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import type {
    Http1Connection,
    Http1ConnectionId,
    Http1ConnectionState,
    HttpRequest,
    HttpResponse,
} from "@browsercore/http1";
import type { Http2Connection, Http2Request, Http2Response } from "@browsercore/http2";
import type { TlsConnection } from "@browsercore/tls";
import { createPool, type ConnectionPool } from "../src/pool.js";
import { openTcpTransport } from "../src/dispatch.js";
import { parseUrl } from "../src/url.js";
import type { ParsedUrl } from "../src/types.js";

// ---------------------------------------------------------------------------
// Hoisted mock references. Declared here so the `vi.mock` factory (hoisted by
// Vitest to the top of the file) and the test bodies share the same `vi.fn`
// instances.
// ---------------------------------------------------------------------------

const mockConnect = vitestVi.hoisted(() => vi.fn());
const mockConnectTls = vitestVi.hoisted(() => vi.fn());
const mockConnectHttp1 = vitestVi.hoisted(() => vi.fn());
const mockConnectHttp2 = vitestVi.hoisted(() => vi.fn());

/**
 * Mock `@browsercore/transport`: replace `connect` with a spy. No
 * `requireDeps` — that was the steel chain, removed.
 */
vi.mock("@browsercore/transport", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/transport")>();
    return {
        ...actual,
        connect: (opts: unknown) => mockConnect(opts),
    };
});

/**
 * Mock the lower layers (@browsercore/tls, http1, http2) so the pool's
 * production path — `openTcpTransport` → `establishConnection` → TLS → HTTP —
 * runs end-to-end against in-memory fakes instead of a real network. The
 * ALPN-driven branch is steered by the `alpnProtocol` reported by the fake
 * TLS connection (`http/1.1` here, matching the pool's default behavior).
 */
vi.mock("@browsercore/tls", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/tls")>();
    return { ...actual, connectTls: (opts: unknown) => mockConnectTls(opts) };
});

vi.mock("@browsercore/http1", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/http1")>();
    return { ...actual, connectHttp1: (opts: unknown) => mockConnectHttp1(opts) };
});

vi.mock("@browsercore/http2", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/http2")>();
    return { ...actual, connectHttp2: (opts: unknown) => mockConnectHttp2(opts) };
});

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

const fakeNet = { connect: () => undefined } as unknown as Net;
const fakeDns = { lookup: () => undefined } as unknown as DnsResolver;

/** A fake Platform — the decoupled way to inject runtime dependencies. */
function fakePlatform(): Platform {
    return {
        network: { tcp: fakeNet, dns: fakeDns, udp: {} as never },
        crypto: { provider: {} as never },
        compression: {} as never,
        events: {} as never,
        telemetry: {} as never,
        time: {} as never,
    };
}

/** A minimal stand-in for a `Transport`. The connect mock returns this. */
class StubTransport extends EventEmitter implements Transport {
    public readonly id: TransportId = "stub-transport" as TransportId;
    public closed = false;
    public get state(): TransportState {
        return this.closed
            ? { state: "closed", reason: { kind: "client_close" } }
            : { state: "open" };
    }
    public write(): Promise<void> {
        return Promise.resolve();
    }
    public read(): Promise<Uint8Array> {
        // Never resolves; no bytes flow in these tests.
        return new Promise(() => {});
    }
    public close(): Promise<void> {
        this.closed = true;
        this.emit("close", false);
        return Promise.resolve();
    }
}

/**
 * Fake TLS connection. `adaptTlsToTransport` in the production path consumes
 * this shape, and `establishConnection` reads `alpnProtocol` to pick the HTTP
 * version. Reporting `http/1.1` steers the branch the pool defaults to.
 */
function fakeTlsConn(): TlsConnection {
    return Object.assign(new EventEmitter(), {
        id: "tls-fake",
        alpnProtocol: "http/1.1",
        state: { state: "open" },
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue({ payload: new Uint8Array() }),
        close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as TlsConnection;
}

/** Fake HTTP/1.1 connection — records nothing, just satisfies the shape. */
function fakeHttp1Conn(): Http1Connection {
    const request = vi.fn(async function (req: HttpRequest): Promise<HttpResponse> {
        return {
            statusCode: 200,
            statusText: "OK",
            headers: new Map(req.headers),
            body: new Uint8Array(0),
        };
    });
    const close = vi.fn(async function close(): Promise<void> {
        return;
    });
    return {
        id: "h1-fake" as Http1ConnectionId,
        state: { state: "idle" } as Http1ConnectionState,
        request,
        close,
    } as unknown as Http1Connection;
}

/**
 * A TLS 1.3-capable fallback profile. The production path validates the
 * profile's `supportedVersions` and rejects any profile that advertises no
 * TLS 1.3 (the TLS layer negotiates TLS 1.3 only).
 */
function fallbackProfile(): BrowserProfile {
    return {
        id: "default" as ProfileId,
        name: "default",
        version: "0.0.0",
        tls: {
            cipherSuites: ["TLS_AES_128_GCM_SHA256"],
            extensionOrder: [],
            supportedVersions: ["TLS 1.3"],
            keyShareGroups: ["x25519"],
            signatureAlgorithms: ["ecdsa_secp256r1_sha256"],
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

const lookupProfile = (_id: ProfileId): BrowserProfile | undefined => undefined;

function url(s: string): ParsedUrl {
    return parseUrl(s);
}

// ---------------------------------------------------------------------------
// Per-test isolation.
// ---------------------------------------------------------------------------

beforeEach(() => {
    mockConnect.mockReset();
    mockConnectTls.mockReset();
    mockConnectHttp1.mockReset();
    mockConnectHttp2.mockReset();
});

// ---------------------------------------------------------------------------
// 1. `openTcpTransport` uses provided adapters directly.
// ---------------------------------------------------------------------------

describe("openTcpTransport — uses provided adapters", () => {
    it("opens a TCP transport with the provided net/dns adapters", async () => {
        mockConnect.mockResolvedValue(new StubTransport());

        const parsed = url("https://example.com:8443/path");
        const result = await openTcpTransport(parsed, fakeNet, fakeDns);

        expect(mockConnect).toHaveBeenCalledTimes(1);
        const connectArg = mockConnect.mock.calls[0]! as ReadonlyArray<unknown>;
        expect((connectArg[0] as { host: string }).host).toBe("example.com");
        expect((connectArg[0] as { port: number }).port).toBe(8443);
        expect((connectArg[0] as { net: Net }).net).toBe(fakeNet);
        expect((connectArg[0] as { dns: DnsResolver }).dns).toBe(fakeDns);
        expect(result).toBeInstanceOf(StubTransport);
    });
});

// ---------------------------------------------------------------------------
// 2. `openTcpTransport` without adapters throws FetchError.
// ---------------------------------------------------------------------------

describe("openTcpTransport — throws without adapters", () => {
    it("throws FetchError when called without net/dns", () => {
        const parsed = url("https://example.com:8443/path");
        expect(() => openTcpTransport(parsed)).toThrow(
            "openTcpTransport requires net and dns adapters",
        );
        expect(mockConnect).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 3. Pool with net/dns from Platform establishes connections.
// ---------------------------------------------------------------------------

describe("pool integration — Platform provides adapters", () => {
    it("establishes a connection using adapters from Platform", async () => {
        // Production wiring: Platform flows net/dns through client → pool →
        // dispatch. No global singleton, no steel chain.
        mockConnect.mockImplementation(() => Promise.resolve(new StubTransport()));
        mockConnectTls.mockResolvedValue(fakeTlsConn());
        mockConnectHttp1.mockResolvedValue(fakeHttp1Conn());

        const platform = fakePlatform();
        const pool: ConnectionPool = createPool(
            { net: platform.network.tcp, dns: platform.network.dns },
            lookupProfile,
            fallbackProfile(),
        );
        try {
            const pooled = await pool.getConnection(url("http://example.com/"), undefined);
            expect(pooled.protocol).toBe("http1");

            expect(mockConnect).toHaveBeenCalledTimes(1);
            const connectArg = mockConnect.mock.calls[0]! as ReadonlyArray<unknown>;
            expect((connectArg[0] as { host: string }).host).toBe("example.com");
            expect((connectArg[0] as { port: number }).port).toBe(80);
            expect((connectArg[0] as { net: Net }).net).toBe(fakeNet);
            expect((connectArg[0] as { dns: DnsResolver }).dns).toBe(fakeDns);
            // The resolved adapters flowed all the way into the TLS handshake.
            expect(mockConnectTls).toHaveBeenCalledTimes(1);
            expect(mockConnectHttp1).toHaveBeenCalledTimes(1);
        } finally {
            await pool.drain();
        }
    });
});

// ---------------------------------------------------------------------------
// 4. Pool without adapters surfaces a typed error.
// ---------------------------------------------------------------------------

describe("pool integration — no adapters throws", () => {
    it("throws when the pool has no net/dns and no Platform", async () => {
        const pool: ConnectionPool = createPool({}, lookupProfile, fallbackProfile());
        await expect(pool.getConnection(url("http://example.com/"), undefined)).rejects.toThrow(
            "openTcpTransport requires net and dns adapters",
        );
        expect(mockConnect).not.toHaveBeenCalled();
    });
});
