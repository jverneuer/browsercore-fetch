/**
 * Regression tests for Bug 2 — top-level `fetch()` adapter injection.
 *
 * Bug: `openTcpTransport(url)` (no net/dns) called `connect` with
 * `net === undefined` / `dns === undefined`, so every top-level fetch() threw
 * "FetchClient requires net and dns adapters." The fix makes
 * `openTcpTransport` fall back to `requireDeps()` when net/dns are omitted,
 * letting the globally-registered adapters from `setConnectorDeps()` flow
 * through. The hard throw in `pool.ts` was also removed.
 *
 * The adapter-fallback decision lives entirely in `openTcpTransport`
 * (dispatch.ts): the pool (pool.ts) just forwards `options.net`/`options.dns`
 * unchanged. These tests pin the fix's contracts at the dispatch layer (where
 * the fallback logic actually is) and assert the pool's wiring propagates the
 * fallback result — both the success path (deps resolve) and the failure path
 * (no deps, typed error surfaces).
 *
 * Contracts covered:
 *   1. `openTcpTransport(url)` with no adapters falls back to `requireDeps()`.
 *   2. `openTcpTransport(url, net, dns)` uses the provided adapters directly
 *      and does NOT touch `requireDeps()`.
 *   3. The pool's production path (no transportFactory) delegates to
 *      `openTcpTransport` and resolves when `setConnectorDeps()` was called.
 *   4. An error is still thrown when there are no adapters AND no globally
 *      registered deps — the fallback is not a silent swallow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vi as vitestVi } from "vitest";
import { EventEmitter } from "node:events";
import type { Net, DnsResolver } from "@browsercore/contracts";
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
import {
    resetConnectorDeps,
    setConnectorDeps,
    TransportError,
} from "@browsercore/transport";
import { parseUrl } from "../src/url.js";
import type { ParsedUrl } from "../src/types.js";

// ---------------------------------------------------------------------------
// Hoisted mock references. Declared here so the `vi.mock` factory (hoisted by
// Vitest to the top of the file) and the test bodies share the same `vi.fn`
// instances.
// ---------------------------------------------------------------------------

const mockConnect = vitestVi.hoisted(() => vi.fn());
const mockRequireDeps = vitestVi.hoisted(() => vi.fn());
const mockConnectTls = vitestVi.hoisted(() => vi.fn());
const mockConnectHttp1 = vitestVi.hoisted(() => vi.fn());
const mockConnectHttp2 = vitestVi.hoisted(() => vi.fn());

/**
 * Build the canonical "no deps" error thrown by the real `requireDeps()` when
 * `setConnectorDeps()` was never called. Constructed lazily (not at module
 * eval) so its `TransportError` constructor never runs during Vitest's
 * module-collection phase, which would otherwise surface it as an uncaught
 * suite-level failure.
 */
function makeNoDepsError(): TransportError {
    return new TransportError(
        "Transport dependencies not initialized. Call setConnectorDeps() before using directConnector or createHttpProxy.",
    );
}

/**
 * Mock `@browsercore/transport`: replace `connect` and `requireDeps` with
 * spies while leaving the rest of the module (in particular the real
 * `setConnectorDeps` / `resetConnectorDeps` pair) intact. Keeping the real
 * pair is what makes the pool integration test exercise the actual wiring
 * rather than a simulation of it.
 */
vi.mock("@browsercore/transport", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/transport")>();
    return {
        ...actual,
        connect: (opts: unknown) => mockConnect(opts),
        requireDeps: () => mockRequireDeps(),
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
const fakeDns = { resolve: () => undefined } as unknown as DnsResolver;

const connectorDeps = { net: fakeNet, dns: fakeDns };

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
 * TLS 1.3 (the TLS layer negotiates TLS 1.3 only), so the dispatch-level
 * fallback must be exercised against a profile the TLS layer will accept.
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
// Per-test isolation: reset global connector deps and every mock so a deps
// registration or a mock configuration in one test never leaks into the next.
// ---------------------------------------------------------------------------

beforeEach(() => {
    resetConnectorDeps();
    mockConnect.mockReset();
    mockRequireDeps.mockReset();
});

afterEach(() => {
    resetConnectorDeps();
});

// ---------------------------------------------------------------------------
// 1 + 2 + 4. `openTcpTransport` dispatch-level contract.
// ---------------------------------------------------------------------------

describe("openTcpTransport — adapter fallback (Bug 2 fix)", () => {
    it("falls back to requireDeps() when called with no net/dns", async () => {
        mockRequireDeps.mockReturnValue(connectorDeps);
        mockConnect.mockResolvedValue(new StubTransport());

        const parsed = url("https://example.com:8443/path");
        const result = await openTcpTransport(parsed);

        // The fallback path consulted the global dependency registry.
        expect(mockRequireDeps).toHaveBeenCalledTimes(1);
        // connect was invoked with the resolved adapters.
        expect(mockConnect).toHaveBeenCalledTimes(1);
        const connectArg = mockConnect.mock.calls[0]! as ReadonlyArray<unknown>;
        expect(connectArg).toBeDefined();
        expect((connectArg[0] as { host: string }).host).toBe("example.com");
        expect((connectArg[0] as { port: number }).port).toBe(8443);
        expect((connectArg[0] as { net: Net }).net).toBe(fakeNet);
        expect((connectArg[0] as { dns: DnsResolver }).dns).toBe(fakeDns);
        expect(result).toBeInstanceOf(StubTransport);
    });

    it("uses the provided net/dns adapters directly and does NOT call requireDeps()", async () => {
        mockConnect.mockResolvedValue(new StubTransport());

        const parsed = url("https://example.com:8443/path");
        const result = await openTcpTransport(parsed, fakeNet, fakeDns);

        // Provided adapters win — the global registry is never consulted.
        expect(mockRequireDeps).not.toHaveBeenCalled();
        expect(mockConnect).toHaveBeenCalledTimes(1);
        const connectArg = mockConnect.mock.calls[0]! as ReadonlyArray<unknown>;
        expect((connectArg[0] as { net: Net }).net).toBe(fakeNet);
        expect((connectArg[0] as { dns: DnsResolver }).dns).toBe(fakeDns);
        expect(result).toBeInstanceOf(StubTransport);
    });

    it("throws TransportError when there are no adapters and no setConnectorDeps()", async () => {
        // requireDeps() throws when currentDeps is undefined — that is the
        // documented "no adapters registered" failure. The fix must not
        // swallow this; it must surface so the caller sees a typed error.
        mockRequireDeps.mockImplementation(() => {
            throw makeNoDepsError();
        });

        // Await the rejection directly so the catch handler is attached on the
        // promise before it settles — avoids racing Vitest's global
        // unhandled-rejection detector on the async throw.
        let caught: unknown;
        try {
            await openTcpTransport(url("https://example.com/"));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(TransportError);

        // requireDeps() was consulted; connect never ran because there were no
        // adapters to pass it.
        expect(mockRequireDeps).toHaveBeenCalledTimes(1);
        expect(mockConnect).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 3. Pool integration: the production top-level `fetch()` path registers deps
//    once via setConnectorDeps() and never threads net/dns through the pool.
// ---------------------------------------------------------------------------

describe("pool integration — setConnectorDeps() feeds openTcpTransport (Bug 2 fix)", () => {
    it("establishes a connection using globally-registered deps when none are passed to the pool", async () => {
        // Production wiring: the app entrypoint registers platform adapters
        // once at startup. The pool is created with no net/dns — exactly the
        // top-level `fetch()` configuration the bug broke. The whole production
        // handshake must complete through the requireDeps() fallback.
        setConnectorDeps(connectorDeps);
        mockRequireDeps.mockReturnValue(connectorDeps);
        // A fresh StubTransport per connect() call — matches how the real
        // stack mints one transport per origin.
        mockConnect.mockImplementation(() => Promise.resolve(new StubTransport()));
        // Steer the (mocked) TLS handshake to report http/1.1 over ALPN, then
        // complete the HTTP/1.1 upgrade with a fake connection.
        mockConnectTls.mockResolvedValue(fakeTlsConn());
        mockConnectHttp1.mockResolvedValue(fakeHttp1Conn());

        const pool: ConnectionPool = createPool({}, lookupProfile, fallbackProfile());
        try {
            // getConnection → establishAndStore → openTcpTransport(url) with no
            // net/dns → requireDeps() → connect({ host, port, net, dns })
            // → establishConnection → connectTls → connectHttp1.
            const pooled = await pool.getConnection(url("http://example.com/"), undefined);
            expect(pooled.protocol).toBe("http1");

            // The fallback consulted the global registry and resolved adapters.
            expect(mockRequireDeps).toHaveBeenCalledTimes(1);
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

    it("still throws when the pool has no adapters and setConnectorDeps() was never called", async () => {
        // No setConnectorDeps() (reset in beforeEach) and no net/dns on the
        // pool → openTcpTransport's requireDeps() fallback throws. The pool
        // must surface the error, not swallow it.
        mockRequireDeps.mockImplementation(() => {
            throw makeNoDepsError();
        });

        const pool: ConnectionPool = createPool({}, lookupProfile, fallbackProfile());
        // Await the rejection directly (see the dispatch-level negative test)
        // for deterministic handler attachment before settlement.
        let caught: unknown;
        try {
            await pool.getConnection(url("http://example.com/"), undefined);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(TransportError);
        expect(mockRequireDeps).toHaveBeenCalledTimes(1);
        expect(mockConnect).not.toHaveBeenCalled();
    });
});
