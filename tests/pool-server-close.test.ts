/**
 * Regression tests for issue #72: the pool never evicted entries for
 * server-closed connections, so the first request after an idle gap took the
 * dead connection and failed with a FetchError.
 *
 * Covers both halves of the fix:
 *   1. `watchTransportClose` — a transport `close` while the entry is pooled
 *      (server-side close of an idle connection) evicts that entry, so the
 *      next request dials fresh instead of surfacing an error.
 *   2. The hardened take path — an entry whose transport is already dead at
 *      getConnection time (close event not yet processed) is discarded and
 *      redialed transparently within the same take.
 *
 * Client-initiated semantics must stay unchanged: client.close()/drain() and
 * idle-timeout eviction close the entry themselves before the close event
 * fires, so the watcher's identity guard turns their events into no-ops.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import type { ProxyConfig } from "@browsercore/proxy";
import { createClient } from "../src/client.js";
import { createPool, type ConnectionPool } from "../src/pool.js";
import { FetchError } from "../src/errors.js";
import { parseUrl } from "../src/url.js";
import { stubEvents } from "./helpers/test-platform.js";

// ---------------------------------------------------------------------------
// In-memory transport pair. The CLIENT side of the pair is what the pool
// tracks, so "the server closed the socket" is modeled as a remote close on
// the client side: state flips to closed/remote_close and the `close` event
// fires — the same surface a real TcpTransport exposes when the peer FINs.
// ---------------------------------------------------------------------------

class PairedTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    private stateValue: TransportState = { state: "open" };
    private peer: PairedTransport | undefined;
    private readonly buffer: number[] = [];
    private pendingRead: ((data: Uint8Array) => void) | undefined;
    private pendingReadReject: ((err: Error) => void) | undefined;

    private constructor(id: string) {
        super();
        this.id = id as TransportId;
    }

    public static pair(): { readonly client: PairedTransport; readonly server: PairedTransport } {
        const client = new PairedTransport("client");
        const server = new PairedTransport("server");
        client.peer = server;
        server.peer = client;
        return { client, server };
    }

    public get state(): TransportState {
        return this.stateValue;
    }

    public write(data: Uint8Array): Promise<void> {
        if (this.stateValue.state !== "open") {
            return Promise.reject(new Error(`transport ${this.id} is closed`));
        }
        this.peer?.deliver(data);
        return Promise.resolve();
    }

    public read(): Promise<Uint8Array> {
        if (this.stateValue.state !== "open") {
            return Promise.reject(new Error(`transport ${this.id} is closed`));
        }
        if (this.buffer.length > 0) {
            const data = Uint8Array.from(this.buffer);
            this.buffer.length = 0;
            return Promise.resolve(data);
        }
        return new Promise((resolve, reject) => {
            this.pendingRead = resolve;
            this.pendingReadReject = reject;
        });
    }

    /** Client-initiated graceful close: self closes with client_close; the peer observes a remote close. */
    public close(): Promise<void> {
        this.closeAs({ kind: "client_close" }, true);
        this.peer?.closeAs({ kind: "remote_close" }, true);
        return Promise.resolve();
    }

    /**
     * The PEER closed the socket (server-side close): both ends end up closed
     * with a remote_close reason and the `close` event fires on both — the
     * event the pool's transport watcher subscribes to on the client side.
     */
    public remoteClose(): void {
        this.closeAs({ kind: "remote_close" }, true);
        this.peer?.closeAs({ kind: "remote_close" }, true);
    }

    /**
     * The peer closed the socket but the close event has NOT been delivered
     * yet — the window the hardened take path covers. State flips, no event,
     * no pending-read rejection.
     */
    public markRemoteClosedSilent(): void {
        this.closeAs({ kind: "remote_close" }, false);
        this.peer?.closeAs({ kind: "remote_close" }, false);
    }

    /** Transition to closed; optionally reject a pending read and emit `close`. */
    private closeAs(reason: TransportState extends { state: "closed"; reason: infer R } ? R : never, evented: boolean): void {
        if (this.stateValue.state === "closed") {
            return;
        }
        this.stateValue = { state: "closed", reason };
        if (this.pendingReadReject !== undefined) {
            const reject = this.pendingReadReject;
            this.pendingRead = undefined;
            this.pendingReadReject = undefined;
            reject(new Error("remote closed the connection"));
        }
        if (evented) {
            this.emit("close", false);
        }
    }

    /** Deliver bytes written by the peer (same model as client.test.ts's FakeTransport). */
    private deliver(data: Uint8Array): void {
        for (let i = 0; i < data.length; i++) {
            this.buffer.push(data[i] ?? 0);
        }
        const buffered = Uint8Array.from(this.buffer);
        // Always clear: stale bytes must not be replayed on the next delivery
        // over a reused keep-alive connection.
        this.buffer.length = 0;
        const pending = this.pendingRead;
        if (pending !== undefined) {
            this.pendingRead = undefined;
            this.pendingReadReject = undefined;
        }
        queueMicrotask(() => {
            this.emit("data", buffered);
            if (pending !== undefined) {
                pending(data);
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Minimal HTTP/1.1 fake backend (trimmed from client.test.ts) for the
// client-level tests. A handler returning `undefined` withholds the response
// (the request is left unanswered on the wire and the connection stays open) —
// the test then decides when the server drops the connection.
// ---------------------------------------------------------------------------

interface FakeRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Uint8Array;
}

interface FakeResponse {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array | string;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

function findHeaderEnd(buf: Uint8Array): number {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
            return i;
        }
    }
    return -1;
}

function decodeAscii(buf: Uint8Array, start: number, end: number): string {
    let out = "";
    for (let i = start; i < end; i++) {
        out += String.fromCharCode(buf[i] ?? 0);
    }
    return out;
}

function tryParseRequest(buf: Uint8Array): { request: FakeRequest; consumed: number } | null {
    const headerEnd = findHeaderEnd(buf);
    if (headerEnd === -1) {
        return null;
    }
    const bodyStart = headerEnd + 4;
    const headerText = decodeAscii(buf, 0, headerEnd);
    const firstLineEnd = headerText.indexOf("\r\n");
    const requestLine = headerText.slice(0, firstLineEnd === -1 ? headerText.length : firstLineEnd);
    const parts = requestLine.split(" ");
    const headers = new Map<string, string>();
    for (const line of headerText.slice(firstLineEnd + 2).split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) {
            continue;
        }
        headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
    }
    const match = /(?:^|\n)content-length:\s*(\d+)\r?/i.exec(headerText);
    const cl = match?.[1];
    if (cl !== undefined) {
        const n = Number(cl);
        if (buf.length < bodyStart + n) {
            return null;
        }
        return {
            request: {
                method: parts[0] ?? "",
                url: parts[1] ?? "",
                headers,
                body: buf.slice(bodyStart, bodyStart + n),
            },
            consumed: bodyStart + n,
        };
    }
    return {
        request: { method: parts[0] ?? "", url: parts[1] ?? "", headers, body: new Uint8Array(0) },
        consumed: bodyStart,
    };
}

function serializeResponse(resp: FakeResponse): Uint8Array {
    const bodyBytes =
        resp.body === undefined
            ? new Uint8Array(0)
            : typeof resp.body === "string"
              ? new TextEncoder().encode(resp.body)
              : resp.body;
    const headers: Record<string, string> = { "content-length": String(bodyBytes.length) };
    if (resp.headers !== undefined) {
        for (const [k, v] of Object.entries(resp.headers)) {
            headers[k] = v;
        }
    }
    let text = `HTTP/1.1 ${resp.status} ${resp.statusText ?? ""}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
        text += `${k}: ${v}\r\n`;
    }
    text += "\r\n";
    const headerBytes = new TextEncoder().encode(text);
    const out = new Uint8Array(headerBytes.length + bodyBytes.length);
    out.set(headerBytes, 0);
    out.set(bodyBytes, headerBytes.length);
    return out;
}

/** Server side of one pooled connection: parses requests, answers via the handler. */
class FakeHttpServer {
    private buffer: Uint8Array = new Uint8Array(0);
    private readonly wakeups: Array<() => void> = [];
    private seenRequests = 0;
    private closed = false;

    public constructor(
        private readonly transport: PairedTransport,
        private readonly handler: (req: FakeRequest) => FakeResponse | undefined,
    ) {
        transport.on("data", (chunk: Uint8Array) => {
            this.buffer = concat(this.buffer, chunk);
            this.wakeAll();
        });
        transport.on("close", () => {
            this.closed = true;
            this.wakeAll();
        });
        void this.loop();
    }

    /** Resolves once `count` requests have arrived on the wire. */
    public waitForRequests(count: number): Promise<void> {
        return new Promise((resolve) => {
            const tryResolve = (): void => {
                if (this.seenRequests >= count) {
                    resolve();
                    return;
                }
                // Not satisfied yet — re-register so the next wake re-checks.
                this.wakeups.push(tryResolve);
            };
            tryResolve();
        });
    }

    private wakeAll(): void {
        for (const wake of this.wakeups.splice(0)) {
            wake();
        }
    }

    private async loop(): Promise<void> {
        for (;;) {
            const req = await this.nextRequest();
            if (req === undefined) {
                return;
            }
            this.seenRequests += 1;
            this.wakeAll();
            const resp = this.handler(req);
            if (resp === undefined) {
                // Withhold the response — the request hangs unanswered so the
                // test can drop the connection at a controlled moment.
                return;
            }
            try {
                await this.transport.write(serializeResponse(resp));
            } catch {
                // Connection closed mid-write (test tore it down).
                return;
            }
        }
    }

    private nextRequest(): Promise<FakeRequest | undefined> {
        return new Promise((resolve) => {
            const tryResolve = (): void => {
                const parsed = tryParseRequest(this.buffer);
                if (parsed !== null) {
                    this.buffer = this.buffer.slice(parsed.consumed);
                    resolve(parsed.request);
                    return;
                }
                if (this.closed) {
                    resolve(undefined);
                }
            };
            tryResolve();
            this.wakeups.push(() => {
                tryResolve();
            });
        });
    }
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

const events = stubEvents();

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

/** Pool over PairedTransport dials; exposes the client transports for server-side closes. */
function makePool(opts: { idleTimeoutMs?: number }): {
    pool: ConnectionPool;
    dials: Array<{ host: string; port: number }>;
    clientTransports: PairedTransport[];
} {
    const dials: Array<{ host: string; port: number }> = [];
    const clientTransports: PairedTransport[] = [];
    const pool = createPool({
        idleTimeoutMs: opts.idleTimeoutMs,
        events,
        transportFactory: (host: string, port: number): Transport => {
            dials.push({ host, port });
            const pair = PairedTransport.pair();
            clientTransports.push(pair.client);
            return pair.client;
        },
    }, lookup, fallbackProfile());
    return { pool, dials, clientTransports };
}

/** Client over PairedTransport-backed fake HTTP servers. */
function makeClient(handler: (req: FakeRequest) => FakeResponse | undefined): {
    client: ReturnType<typeof createClient>;
    dials: Array<{ host: string; port: number }>;
    servers: FakeHttpServer[];
    clientTransports: PairedTransport[];
} {
    const dials: Array<{ host: string; port: number }> = [];
    const servers: FakeHttpServer[] = [];
    const clientTransports: PairedTransport[] = [];
    const client = createClient({
        events,
        transportFactory: (host: string, port: number): Transport => {
            dials.push({ host, port });
            const pair = PairedTransport.pair();
            servers.push(new FakeHttpServer(pair.server, handler));
            clientTransports.push(pair.client);
            return pair.client;
        },
    });
    return { client, dials, servers, clientTransports };
}

/** Flush microtasks + timers so evented evictions have been processed. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const PROXY_A: ProxyConfig = { scheme: "http", host: "proxy-a.test", port: 8080 };
const PROXY_B: ProxyConfig = { scheme: "socks5h", host: "proxy-b.test", port: 1080 };

// ---------------------------------------------------------------------------
// Pool-level: eviction of server-closed entries + hardened take path
// ---------------------------------------------------------------------------

describe("pool — server-closed idle connections are evicted (#72)", () => {
    it("evicts the pooled entry when the server closes the socket while idle; next take dials fresh", async () => {
        const { pool, dials, clientTransports } = makePool({});
        try {
            const first = await pool.getConnection(parseUrl("http://example.com/"), undefined);
            pool.release(parseUrl("http://example.com/"));
            expect(dials).toHaveLength(1);

            // The server drops the idle connection: the client transport sees
            // a remote close and emits `close` — previously nothing listened.
            clientTransports[0]?.remoteClose();
            await settle();

            const second = await pool.getConnection(parseUrl("http://example.com/"), undefined);
            expect(second).not.toBe(first);
            expect(dials).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });

    it("redials transparently within the take when the taken transport is already dead (no close event processed)", async () => {
        const { pool, dials, clientTransports } = makePool({});
        try {
            const first = await pool.getConnection(parseUrl("http://example.com/"), undefined);
            pool.release(parseUrl("http://example.com/"));

            // State flipped to remote_close but NO close event was delivered —
            // the watcher cannot have fired; only the take-path check saves us.
            clientTransports[0]?.markRemoteClosedSilent();

            // One getConnection: discards the dead entry + dials fresh inside
            // the same call. Resolves (never rejects), returns the new conn.
            const second = await pool.getConnection(parseUrl("http://example.com/"), undefined);
            expect(second).not.toBe(first);
            expect(dials).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });

    it("evicts only the closed entry's key — sibling proxied/direct entries are untouched", async () => {
        const { pool, dials, clientTransports } = makePool({});
        try {
            const viaA = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            pool.release(parseUrl("http://example.com/"), PROXY_A);
            const viaB = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_B);
            pool.release(parseUrl("http://example.com/"), PROXY_B);
            const direct = await pool.getConnection(parseUrl("http://example.com/"), undefined);
            pool.release(parseUrl("http://example.com/"));
            expect(dials).toHaveLength(3);

            // The proxy-A connection dies. Its key includes the proxy identity,
            // so only that entry may be evicted.
            clientTransports[0]?.remoteClose();
            await settle();

            const viaAAgain = await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_A);
            expect(viaAAgain).not.toBe(viaA);
            expect(dials).toHaveLength(4);
            // B and direct were NOT evicted: same connections, no new dials.
            expect(await pool.getConnection(parseUrl("http://example.com/"), undefined, PROXY_B)).toBe(viaB);
            expect(await pool.getConnection(parseUrl("http://example.com/"), undefined)).toBe(direct);
            expect(dials).toHaveLength(4);
        } finally {
            await pool.drain();
        }
    });

    it("keeps client-initiated closes as no-ops for the watcher: idle eviction and drain still work", async () => {
        const { pool, dials, clientTransports } = makePool({ idleTimeoutMs: 40 });
        try {
            // Idle eviction: the pool closes the conn itself (close event
            // fires after the maps are cleared — the watcher must no-op).
            await pool.getConnection(parseUrl("http://example.com/"), undefined);
            pool.release(parseUrl("http://example.com/"));
            await new Promise((resolve) => setTimeout(resolve, 90));
            expect(clientTransports[0]?.state.state).toBe("closed");
            await pool.getConnection(parseUrl("http://example.com/"), undefined);
            expect(dials).toHaveLength(2);

            // Drain: closes every conn; the watcher must not re-enter.
            await pool.drain();
            expect(clientTransports[1]?.state.state).toBe("closed");
            await pool.getConnection(parseUrl("http://example.com/"), undefined);
            expect(dials).toHaveLength(3);
        } finally {
            await pool.drain();
        }
    });
});

// ---------------------------------------------------------------------------
// Client-level: the user-visible regression from the issue
// ---------------------------------------------------------------------------

/** A minimal 200 response every happy-path handler returns. */
const ok = (): FakeResponse => ({ status: 200, statusText: "OK", body: "ok" });

describe("client — transparent recovery on server-closed pooled connections", () => {
    it("serves the next request after a server-closed idle gap WITHOUT surfacing an error (fresh dial)", async () => {
        const { client, dials, clientTransports } = makeClient(() => ok());
        try {
            const first = await client.fetch("http://example.com/one");
            expect(first.status).toBe(200);
            expect(dials).toHaveLength(1);

            // Idle gap: the server closes the pooled socket.
            clientTransports[0]?.remoteClose();
            await settle();

            // The exact failure mode from the issue: this used to reject with
            // a connection-level FetchError; now it succeeds transparently.
            const second = await client.fetch("http://example.com/two");
            expect(second.status).toBe(200);
            expect(dials).toHaveLength(2);
        } finally {
            await client.close();
        }
    });

    it("redials transparently within ONE request when the taken connection is already dead (take/take race)", async () => {
        const { client, dials, clientTransports } = makeClient(() => ok());
        try {
            const first = await client.fetch("http://example.com/one");
            expect(first.status).toBe(200);
            expect(dials).toHaveLength(1);

            // Remote close flipped the state but no close event was delivered.
            clientTransports[0]?.markRemoteClosedSilent();

            // One fetch: dead entry discarded + fresh dial inside the same
            // request, before any request bytes are sent.
            const second = await client.fetch("http://example.com/two");
            expect(second.status).toBe(200);
            expect(dials).toHaveLength(2);
        } finally {
            await client.close();
        }
    });

    it("surfaces the error when data was already exchanged, and the following request succeeds", async () => {
        // The connection dies MID-REQUEST — request bytes went out, no answer
        // ever comes — past the point where a redial could be transparent.
        const { client, dials, servers, clientTransports } = makeClient((req) =>
            req.url === "/two" ? undefined : ok(),
        );
        try {
            const first = await client.fetch("http://example.com/one");
            expect(first.status).toBe(200);

            const second = client.fetch("http://example.com/two");
            // The request bytes reached the server (data already exchanged).
            await servers[0]?.waitForRequests(2);
            // Flush a macrotask so the protocol layer has registered its read
            // — matching a real FIN, which always arrives in its own
            // event-loop turn — then the server drops the connection.
            await new Promise((resolve) => setTimeout(resolve, 0));
            clientTransports[0]?.remoteClose();

            // The error MUST surface (no band-aid retry of the request flow).
            await expect(second).rejects.toThrow(FetchError);
            // The dead entry was evicted; the next request dials fresh and succeeds.
            const third = await client.fetch("http://example.com/three");
            expect(third.status).toBe(200);
            expect(dials).toHaveLength(2);
        } finally {
            await client.close();
        }
    });

    it("client.close() still tears down every pooled connection", async () => {
        const { client, dials, clientTransports } = makeClient(() => ok());
        try {
            await client.fetch("http://example.com/one");
            expect(dials).toHaveLength(1);
            await client.close();
            // The pooled transport was closed by the drain itself.
            expect(clientTransports[0]?.state.state).toBe("closed");
            // The pool is empty: the next fetch dials fresh.
            const next = await client.fetch("http://example.com/two");
            expect(next.status).toBe(200);
            expect(dials).toHaveLength(2);
        } finally {
            await client.close();
        }
    });
});
