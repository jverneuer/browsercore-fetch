/**
 * Proxy support tests — the three layers the feature touches:
 *
 * 1. `openProxiedTransport` (dispatch.ts): the dial boundary. Runs the REAL
 *    @browsercore/proxy handshakes over a callback-based FakeSocket Net
 *    adapter (same model as @browsercore/proxy's own dial tests) — proving
 *    fetch dials the PROXY endpoint, dispatches CONNECT vs SOCKS5/5h via the
 *    config's scheme, never pre-resolves the origin itself, and wraps proxy
 *    failures into FetchProxyError at the boundary.
 * 2. Pool keying (pool.ts + url.ts): via the transportFactory seam, which
 *    receives the endpoint actually dialed — the proxy's when proxied.
 *    Two proxies (or two credential sets on one proxy) to the same origin
 *    must never share a connection; the same proxy must be reused.
 * 3. Client option resolution (client.ts): per-request `proxy` replaces the
 *    client default; absent per-request proxy falls back to the default.
 */

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ConnectOptions, DnsResolver, Net, Socket } from "@browsercore/contracts";
import { ProxyAuthError, type ProxyConfig } from "@browsercore/proxy";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import { createClient } from "../src/client.js";
import { openProxiedTransport } from "../src/dispatch.js";
import { FetchError, FetchProxyError } from "../src/errors.js";
import { createPool, type ConnectionPool } from "../src/pool.js";
import { fnv1a64Hex, proxyDialPlatform, proxyIdentity } from "../src/proxy.js";
import { parseUrl, poolKey } from "../src/url.js";
import { stubEvents } from "./helpers/test-platform.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROXY_HTTP: ProxyConfig = { scheme: "http", host: "proxy.internal", port: 8080 };
const PROXY_SOCKS5: ProxyConfig = { scheme: "socks5", host: "proxy.internal", port: 1080 };
const PROXY_SOCKS5H: ProxyConfig = { scheme: "socks5h", host: "proxy.internal", port: 1080 };

function bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function text(data: Uint8Array): string {
    return new TextDecoder().decode(data);
}

/** Capture a promise's rejection value so its fields can be asserted. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error("expected the promise to reject, but it resolved");
}

/** Poll until `predicate` holds; fails the test after a generous budget. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`timed out waiting for: ${what}`);
}

/** Callback-based fake of the contracts Socket surface (drives the proxy dialer). */
class FakeSocket implements Socket {
    public readonly written: Uint8Array[] = [];
    public destroyed = false;

    private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
    private readonly onceListeners = new Map<string, Set<(...args: never[]) => void>>();

    public write(data: Uint8Array, cb?: (err?: Error | null) => void): boolean {
        this.written.push(data);
        cb?.(null);
        return true;
    }

    public end(): void {
        this.emitCustom("close", false);
    }

    public destroy(error?: Error): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        if (error !== undefined) {
            this.emitCustom("error", error);
        }
        this.emitCustom("close", true);
    }

    public once(event: string, listener: (...args: never[]) => void): void {
        const set = this.onceListeners.get(event) ?? new Set();
        set.add(listener);
        this.onceListeners.set(event, set);
    }

    public on(event: string, listener: (...args: never[]) => void): void {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
    }

    /** Test seam: deliver bytes as if they arrived from the network. */
    public pushData(chunk: Uint8Array): void {
        this.emitCustom("data", chunk);
    }

    /** Test seam: fire an arbitrary event at registered listeners. */
    public emitCustom(event: string, ...args: unknown[]): void {
        for (const listener of [...(this.onceListeners.get(event) ?? [])]) {
            listener(...(args as never[]));
        }
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            listener(...(args as never[]));
        }
    }
}

/** A Net adapter that records every dial and hands out scripted sockets. */
class RecordingNet implements Net {
    public readonly dials: Array<{ readonly host: string; readonly port: number }> = [];
    private dialCount = 0;

    public constructor(private readonly socket: () => FakeSocket) {}

    public connect(options: ConnectOptions): Socket {
        this.dialCount += 1;
        this.dials.push({ host: options.host, port: options.port });
        return this.socket();
    }

    public get calls(): number {
        return this.dialCount;
    }
}

/** A Net adapter whose connect throws a plain (non-proxy) error. */
class ThrowingNet implements Net {
    public connect(): Socket {
        throw new Error("dial exploded");
    }
}

/** A DnsResolver stub returning one fixed address; records every lookup. */
function recordingDns(address = "203.0.113.7"): DnsResolver & { calls: string[] } {
    const dns = {
        calls: [] as string[],
        lookup(hostname: string, family: 4 | 6): Promise<{ address: string; family: 4 | 6 }[]> {
            dns.calls.push(`${hostname}/${family}`);
            return Promise.resolve([{ address, family }]);
        },
    };
    return dns;
}

/** Minimal openable/closable transport for pool lifecycle tests. */
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
        return new Promise(() => {});
    }
    public close(): Promise<void> {
        this.closed = true;
        this.emit("close", false);
        return Promise.resolve();
    }
}

// ---------------------------------------------------------------------------
// 1. openProxiedTransport — the dial boundary
// ---------------------------------------------------------------------------

describe("openProxiedTransport — dial target + scheme dispatch", () => {
    it("dials the PROXY endpoint (not the origin) and sends CONNECT for the origin", async () => {
        const socket = new FakeSocket();
        const net = new RecordingNet(() => socket);
        const dns = recordingDns();
        const url = parseUrl("https://example.com/");

        const pending = openProxiedTransport(url, PROXY_HTTP, net, dns);
        await waitFor(() => socket.written.length >= 1, "CONNECT request");

        // The TCP dial went to the proxy; the origin only appears inside the
        // tunnel request, never as a dial target.
        expect(net.dials).toEqual([{ host: "proxy.internal", port: 8080 }]);
        expect(text(socket.written[0] ?? new Uint8Array())).toContain("CONNECT example.com:443 HTTP/1.1");

        socket.pushData(bytes("HTTP/1.1 200 Connection established\r\n\r\n"));
        const tunneled = await pending;

        // The returned transport IS the tunneled stream: bytes written to it
        // reach the proxy socket, bytes from the socket are readable on it.
        await tunneled.write(bytes("ping"));
        await waitFor(() => socket.written.length >= 2, "tunneled write");
        expect(text(socket.written[1] ?? new Uint8Array())).toBe("ping");
        socket.pushData(bytes("pong"));
        expect(text(await tunneled.read())).toBe("pong");
        await expect(tunneled.close()).resolves.toBeUndefined();
    });

    it("needs no dns adapter for the http scheme", async () => {
        const socket = new FakeSocket();
        const net = new RecordingNet(() => socket);
        const pending = openProxiedTransport(parseUrl("https://example.com/"), PROXY_HTTP, net, undefined);
        await waitFor(() => socket.written.length >= 1, "CONNECT request");
        socket.pushData(bytes("HTTP/1.1 200 OK\r\n\r\n"));
        await expect(pending).resolves.toBeDefined();
    });

    it("socks5h sends the ORIGIN HOSTNAME on the wire and never resolves it locally", async () => {
        const socket = new FakeSocket();
        const net = new RecordingNet(() => socket);
        const dns = recordingDns();

        const pending = openProxiedTransport(parseUrl("https://example.com/"), PROXY_SOCKS5H, net, dns);
        await waitFor(() => socket.written.length >= 1, "SOCKS5 greeting");
        expect(socket.written[0]).toEqual(Uint8Array.from([0x05, 0x01, 0x00]));

        socket.pushData(Uint8Array.of(0x05, 0x00));
        await waitFor(() => socket.written.length >= 2, "SOCKS5 CONNECT request");
        const connectBytes = socket.written[1] ?? new Uint8Array(0);
        expect(connectBytes[3]).toBe(0x03); // ATYP domain — remote DNS
        expect(text(connectBytes.subarray(5, 16))).toBe("example.com");
        // The origin was never resolved client-side (remote DNS semantics).
        expect(dns.calls).toEqual([]);

        socket.pushData(Uint8Array.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        await expect(pending).resolves.toBeDefined();
    });

    it("socks5 resolves the origin via the injected dns and sends the resolved IP", async () => {
        const socket = new FakeSocket();
        const net = new RecordingNet(() => socket);
        const dns = recordingDns("203.0.113.7");

        const pending = openProxiedTransport(parseUrl("https://example.com/"), PROXY_SOCKS5, net, dns);
        await waitFor(() => socket.written.length >= 1, "SOCKS5 greeting");
        socket.pushData(Uint8Array.of(0x05, 0x00));
        await waitFor(() => socket.written.length >= 2, "SOCKS5 CONNECT request");

        expect(socket.written[1]).toEqual(Uint8Array.from([
            0x05, 0x01, 0x00, 0x01,
            203, 0, 113, 7, // resolved by the injected dns — not the hostname
            0x01, 0xbb,
        ]));
        expect(dns.calls).toEqual(["example.com/4"]);

        socket.pushData(Uint8Array.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        await expect(pending).resolves.toBeDefined();
    });
});

describe("openProxiedTransport — error mapping at the boundary", () => {
    it("throws a typed FetchError when the net adapter is missing", async () => {
        const failure = await rejectionOf(
            openProxiedTransport(parseUrl("https://example.com/"), PROXY_HTTP, undefined, undefined),
        ) as FetchError;
        expect(failure).toBeInstanceOf(FetchError);
        expect(failure).not.toBeInstanceOf(FetchProxyError);
        expect(failure.message).toContain("net adapter");
    });

    it("wraps ProxyAuthError (HTTP 407) into FetchProxyError, kind preserved", async () => {
        const socket = new FakeSocket();
        const net = new RecordingNet(() => socket);
        const proxy: ProxyConfig = { ...PROXY_HTTP, username: "user", password: "pass" };

        const pending = openProxiedTransport(parseUrl("https://example.com/"), proxy, net, undefined);
        await waitFor(() => socket.written.length >= 1, "CONNECT request");
        socket.pushData(bytes('HTTP/1.1 407 Denied\r\nProxy-Authenticate: Basic realm="x"\r\n\r\n'));

        const failure = await rejectionOf(pending) as FetchProxyError;
        expect(failure).toBeInstanceOf(FetchProxyError);
        expect(failure.kind).toBe("FetchProxyError");
        expect(failure.proxyKind).toBe("ProxyAuthError");
        expect(failure.url).toBe("https://example.com");
        expect(failure.cause).toBeInstanceOf(ProxyAuthError);
    });

    it("wraps ProxyTunnelError (SOCKS5 refusal) into FetchProxyError, kind preserved", async () => {
        const socket = new FakeSocket();
        const net = new RecordingNet(() => socket);

        const pending = openProxiedTransport(parseUrl("https://example.com/"), PROXY_SOCKS5H, net, undefined);
        await waitFor(() => socket.written.length >= 1, "greeting");
        socket.pushData(Uint8Array.of(0x05, 0x00));
        await waitFor(() => socket.written.length >= 2, "CONNECT request");
        socket.pushData(Uint8Array.of(0x05, 0x05, 0x00, 0x01)); // connection refused

        const failure = await rejectionOf(pending) as FetchProxyError;
        expect(failure).toBeInstanceOf(FetchProxyError);
        expect(failure.proxyKind).toBe("ProxyTunnelError");
    });

    it("wraps the dialer's missing-dns ProxyError for socks5 (guides to socks5h)", async () => {
        const socket = new FakeSocket();
        const net = new RecordingNet(() => socket);
        const failure = await rejectionOf(
            openProxiedTransport(parseUrl("https://example.com/"), PROXY_SOCKS5, net, undefined),
        ) as FetchProxyError;
        expect(failure).toBeInstanceOf(FetchProxyError);
        expect(failure.proxyKind).toBe("ProxyError");
        expect(failure.message).toContain("socks5h");
    });

    it("propagates non-proxy errors unchanged (no double wrapping)", async () => {
        const failure = await rejectionOf(
            openProxiedTransport(parseUrl("https://example.com/"), PROXY_HTTP, new ThrowingNet(), undefined),
        );
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(FetchProxyError);
        expect((failure as Error).message).toBe("dial exploded");
    });
});

// ---------------------------------------------------------------------------
// 2. Proxy identity + pool platform assembly (src/proxy.ts)
// ---------------------------------------------------------------------------

describe("proxyIdentity — opaque pool-key identity", () => {
    it("separates credential sets on the same proxy endpoint without embedding them", () => {
        const base = { scheme: "http" as const, host: "proxy.test", port: 8080 };
        const alice = proxyIdentity({ ...base, username: "alice", password: "s3cret" });
        const bob = proxyIdentity({ ...base, username: "bob", password: "s3cret" });
        const aliceAgain = proxyIdentity({ ...base, username: "alice", password: "s3cret" });

        expect(alice).not.toBe(bob);
        expect(alice).toBe(aliceAgain);
        // Raw credentials never appear in the identity (it lands in pool keys,
        // which surface in logs and error paths).
        expect(alice).not.toContain("alice");
        expect(alice).not.toContain("s3cret");
        expect(bob).not.toContain("bob");
    });

    it("fnv1a64Hex is deterministic and distinguishes near-identical inputs", () => {
        expect(fnv1a64Hex("user\u0000pass")).toBe(fnv1a64Hex("user\u0000pass"));
        expect(fnv1a64Hex("user\u0000pass")).not.toBe(fnv1a64Hex("user\u0000pasS"));
        expect(fnv1a64Hex("")).toMatch(/^[0-9a-f]{16}$/u);
    });

    it("poolKey stays bare for direct connections and appends the proxy identity when proxied", () => {
        const url = parseUrl("https://example.com/");
        expect(poolKey(url)).toBe("example.com:443");
        const key = poolKey(url, { ...PROXY_HTTP, username: "alice", password: "s3cret" });
        expect(key.startsWith("example.com:443|via:")).toBe(true);
        expect(key).not.toContain("alice");
    });
});

describe("proxyDialPlatform — minimal dial platform", () => {
    it("carries the resolved net/dns adapters on network", () => {
        const net: Net = { connect: () => ({}) as Socket };
        const dns = recordingDns();
        const platform = proxyDialPlatform(net, dns);
        // Optional chaining only narrows the type — the bundle is present at
        // runtime, and a missing bundle would fail the identity assertion.
        expect(platform.network?.tcp).toBe(net);
        expect(platform.network?.dns).toBe(dns);
    });

    it("leaves network.dns undefined when absent (dialer raises its own typed error)", async () => {
        const net: Net = { connect: () => ({}) as Socket };
        const platform = proxyDialPlatform(net, undefined);
        expect(platform.network?.dns).toBeUndefined();
    });

    it("throws on access to any bundle the dialer must not touch", () => {
        const net: Net = { connect: () => ({}) as Socket };
        const platform = proxyDialPlatform(net, recordingDns());
        // Each bundle is a THROWING getter (src/proxy.ts): optional chaining
        // still evaluates the getter, so the access throws exactly as before.
        expect(() => platform.crypto?.provider).toThrow("platform.crypto");
        expect(() => platform.telemetry?.logger).toThrow("platform.telemetry");
        expect(() => platform.events?.on).toThrow("platform.events");
        // Time IS the Clock since contracts 0.2.7 (no `.clock` sub-bundle) —
        // any member access trips the throwing `time` getter.
        expect(() => platform.time?.now).toThrow("platform.time");
        expect(() => platform.compression?.gzip).toThrow("platform.compression");
        expect(() => platform.network?.udp).toThrow("network.udp");
    });
});

// ---------------------------------------------------------------------------
// 3. Pool keying through the transportFactory seam
// ---------------------------------------------------------------------------

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

const lookupProfile = (_id: ProfileId): BrowserProfile | undefined => undefined;

/** Build a pool whose transportFactory returns a fresh StubTransport per call. */
function makePool(opts: { idleTimeoutMs?: number }): {
    pool: ConnectionPool;
    dials: Array<{ host: string; port: number }>;
    transports: StubTransport[];
} {
    const dials: Array<{ host: string; port: number }> = [];
    const transports: StubTransport[] = [];
    const factory = (host: string, port: number): Transport => {
        dials.push({ host, port });
        const transport = new StubTransport(`t${dials.length}`);
        transports.push(transport);
        return transport;
    };
    const pool = createPool(
        {
            // Conditional spread keeps the key ABSENT (not undefined) under
            // exactOptionalPropertyTypes when no timeout was requested.
            ...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: opts.idleTimeoutMs }),
            events: stubEvents(),
            transportFactory: factory,
        },
        lookupProfile,
        fallbackProfile(),
    );
    return { pool, dials, transports };
}

const PROXY_A: ProxyConfig = { scheme: "http", host: "proxy-a.test", port: 8080 };
const PROXY_B: ProxyConfig = { scheme: "socks5h", host: "proxy-b.test", port: 1080 };

describe("pool — proxy-aware connection reuse", () => {
    it("dials the proxy endpoint for proxied requests (not the origin)", async () => {
        const { pool, dials } = makePool({});
        try {
            await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            expect(dials).toEqual([{ host: "proxy-a.test", port: 8080 }]);
        } finally {
            await pool.drain();
        }
    });

    it("reuses the connection for a second request through the SAME proxy", async () => {
        const { pool, dials } = makePool({});
        try {
            const first = await pool.getConnection(parseUrl("http://example.com/a"), undefined, PROXY_A);
            pool.release(parseUrl("http://example.com/a"), PROXY_A);
            const second = await pool.getConnection(parseUrl("http://example.com/b"), undefined, PROXY_A);
            expect(second).toBe(first);
            expect(dials).toHaveLength(1);
        } finally {
            await pool.drain();
        }
    });

    it("establishes SEPARATE connections for two DIFFERENT proxies to the same origin", async () => {
        const { pool, dials, transports } = makePool({});
        try {
            const viaA = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            pool.release(parseUrl("http://example.com/"), PROXY_A);
            const viaB = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_B);
            expect(viaA).not.toBe(viaB);
            expect(dials).toEqual([
                { host: "proxy-a.test", port: 8080 },
                { host: "proxy-b.test", port: 1080 },
            ]);
            expect(transports).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });

    it("separates connections by credentials on the SAME proxy endpoint", async () => {
        const { pool, dials } = makePool({});
        const anon: ProxyConfig = { scheme: "http", host: "proxy-a.test", port: 8080 };
        const authed: ProxyConfig = { scheme: "http", host: "proxy-a.test", port: 8080, username: "alice", password: "wonder" };
        try {
            const anonConn = await pool.getConnection(parseUrl("http://example.com/"), undefined, anon);
            pool.release(parseUrl("http://example.com/"), anon);
            const authedConn = await pool.getConnection(parseUrl("http://example.com/"), undefined, authed);
            expect(authedConn).not.toBe(anonConn);
            expect(dials).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });

    it("never shares a proxied connection with a DIRECT request to the same origin", async () => {
        const { pool, dials } = makePool({});
        try {
            const proxied = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            pool.release(parseUrl("http://example.com/"), PROXY_A);
            const direct = await pool.getConnection(parseUrl("http://example.com/"), undefined, undefined);
            expect(direct).not.toBe(proxied);
            expect(dials).toEqual([
                { host: "proxy-a.test", port: 8080 }, // proxied dial
                { host: "example.com", port: 80 }, // direct dial
            ]);
        } finally {
            await pool.drain();
        }
    });

    it("teardown(url, proxy) evicts only that origin+proxy entry", async () => {
        const { pool, dials, transports } = makePool({});
        try {
            const viaA = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            pool.release(parseUrl("http://example.com/"), PROXY_A);
            await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_B);
            pool.release(parseUrl("http://example.com/"), PROXY_B);

            pool.teardown(parseUrl("http://example.com/"), PROXY_A);
            expect(transports[0]?.closed).toBe(true);
            expect(transports[1]?.closed).toBe(false);

            // Re-acquire A re-establishes; B's connection is untouched.
            const viaAAgain = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            expect(viaAAgain).not.toBe(viaA);
            expect(dials).toHaveLength(3);
        } finally {
            await pool.drain();
        }
    });

    it("applies idle eviction to tunneled connections like any other", async () => {
        const { pool, dials } = makePool({ idleTimeoutMs: 40 });
        try {
            await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            pool.release(parseUrl("http://example.com/"), PROXY_A);
            await new Promise((resolve) => setTimeout(resolve, 90));
            // Evicted after idling — a new acquire re-dials the proxy.
            await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            expect(dials).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });
});

// ---------------------------------------------------------------------------
// 4. Client-level option resolution + end-to-end dispatch through the seam
// ---------------------------------------------------------------------------

/** A duplex in-memory wire pair (EventEmitter + pull read), as in client.test.ts. */
class FakeWire extends EventEmitter implements Transport {
    public readonly id: TransportId;
    public stateValue: TransportState = { state: "open" };
    private peerRef: FakeWire | undefined;
    private readonly queue: Uint8Array[] = [];
    private pending: ((data: Uint8Array) => void) | undefined;
    private pendingReject: ((error: Error) => void) | undefined;

    constructor(id: string) {
        super();
        this.id = id as TransportId;
    }

    public static pair(): { client: FakeWire; server: FakeWire } {
        const client = new FakeWire("client");
        const server = new FakeWire("server");
        client.peerRef = server;
        server.peerRef = client;
        return { client, server };
    }

    public get state(): TransportState {
        return this.stateValue;
    }

    public write(data: Uint8Array): Promise<void> {
        this.peerRef?.deliver(data);
        return Promise.resolve();
    }

    public read(): Promise<Uint8Array> {
        const next = this.queue.shift();
        if (next !== undefined) {
            return Promise.resolve(next);
        }
        if (this.stateValue.state === "closed") {
            return Promise.reject(new Error("wire closed"));
        }
        return new Promise((resolve, reject) => {
            this.pending = resolve;
            this.pendingReject = reject;
        });
    }

    public close(): Promise<void> {
        if (this.stateValue.state === "closed") {
            return Promise.resolve();
        }
        this.stateValue = { state: "closed", reason: { kind: "client_close" } };
        this.pendingReject?.(new Error("wire closed"));
        this.pending = undefined;
        this.pendingReject = undefined;
        if (this.peerRef && this.peerRef.stateValue.state !== "closed") {
            this.peerRef.stateValue = { state: "closed", reason: { kind: "remote_close" } };
            this.peerRef.pendingReject?.(new Error("wire closed"));
            this.peerRef.pending = undefined;
            this.peerRef.pendingReject = undefined;
        }
        this.emit("close", false);
        return Promise.resolve();
    }

    private deliver(data: Uint8Array): void {
        const pending = this.pending;
        if (pending !== undefined) {
            this.pending = undefined;
            this.pendingReject = undefined;
            pending(data);
        } else {
            this.queue.push(data);
        }
        // Macrotask, not microtask: http1's readChunk pushes its data waiter
        // in the microtask chain that follows the request write. Emitting
        // "data" synchronously-in-a-microtask can beat that push, leaving the
        // waiter un-woken forever. A macrotask guarantees the whole request
        // continuation (including the waiter push) settles first.
        setImmediate(() => {
            this.emit("data", data);
        });
    }
}

/** Serve a canned HTTP/1.1 200 on every complete request head seen on the wire. */
function serveOk(server: FakeWire): void {
    let seen = "";
    server.on("data", (chunk: Uint8Array) => {
        seen += text(chunk);
        if (seen.includes("\r\n\r\n")) {
            seen = "";
            void server.write(bytes("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
        }
    });
}

/** Client whose transportFactory records dialed endpoints and wires fresh fake origins. */
function makeClient(clientDefaults?: { proxy?: ProxyConfig }): {
    client: ReturnType<typeof createClient>;
    dials: Array<{ host: string; port: number }>;
} {
    const dials: Array<{ host: string; port: number }> = [];
    const factory = (host: string, port: number): Transport => {
        dials.push({ host, port });
        const { client, server } = FakeWire.pair();
        serveOk(server);
        return client;
    };
    const client = createClient({
        events: stubEvents(),
        transportFactory: factory,
        ...(clientDefaults?.proxy === undefined ? {} : { proxy: clientDefaults.proxy }),
    });
    return { client, dials };
}

describe("client — proxy option resolution", () => {
    it("uses the client default proxy when the request carries none", async () => {
        const { client, dials } = makeClient({ proxy: PROXY_A });
        try {
            const response = await client.fetch("http://example.com/");
            expect(response.status).toBe(200);
            expect(dials).toEqual([{ host: "proxy-a.test", port: 8080 }]);
        } finally {
            await client.close();
        }
    });

    it("a per-request proxy REPLACES the client default", async () => {
        const { client, dials } = makeClient({ proxy: PROXY_A });
        try {
            const response = await client.fetch("http://example.com/", { proxy: PROXY_B });
            expect(response.status).toBe(200);
            expect(dials).toEqual([{ host: "proxy-b.test", port: 1080 }]);
        } finally {
            await client.close();
        }
    });

    it("dials the origin directly when neither request nor client sets a proxy", async () => {
        const { client, dials } = makeClient();
        try {
            const response = await client.fetch("http://example.com/");
            expect(response.status).toBe(200);
            expect(dials).toEqual([{ host: "example.com", port: 80 }]);
        } finally {
            await client.close();
        }
    });

    it("pools default-proxy and override-proxy requests separately, reusing each", async () => {
        const { client, dials } = makeClient({ proxy: PROXY_A });
        try {
            await client.fetch("http://example.com/1"); // via default (A)
            await client.fetch("http://example.com/2", { proxy: PROXY_B }); // via B
            await client.fetch("http://example.com/3"); // A again — reuse
            await client.fetch("http://example.com/4", { proxy: PROXY_B }); // B again — reuse
            expect(dials).toEqual([
                { host: "proxy-a.test", port: 8080 },
                { host: "proxy-b.test", port: 1080 },
            ]);
        } finally {
            await client.close();
        }
    });

    it("surfaces proxy failures as FetchProxyError with the proxy kind preserved", async () => {
        const dials: Array<{ host: string; port: number }> = [];
        const client = createClient({
            events: stubEvents(),
            transportFactory: (host: string, port: number) => {
                dials.push({ host, port });
                throw new ProxyAuthError("proxy rejected credentials", {
                    scheme: "http",
                    status: 407,
                });
            },
            proxy: PROXY_A,
        });
        try {
            const failure = await rejectionOf(client.fetch("http://example.com/")) as FetchProxyError;
            expect(failure).toBeInstanceOf(FetchProxyError);
            expect(failure.kind).toBe("FetchProxyError");
            expect(failure.proxyKind).toBe("ProxyAuthError");
            expect(dials).toEqual([{ host: "proxy-a.test", port: 8080 }]);
        } finally {
            await client.close();
        }
    });
});
