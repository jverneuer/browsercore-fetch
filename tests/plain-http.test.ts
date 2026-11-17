/**
 * Plain-`http://` dial-path tests (#78).
 *
 * The pool's real (non-seam) dial path used to TLS-wrap every scheme, so any
 * `http://` target failed with a TLS record error ("Decryption failed for
 * record") — the server's plaintext HTTP/1.1 response parsed as TLS records.
 * These tests drive createClient end-to-end over the REAL transport + http1
 * layers (only the Net adapter is fake — the same FakeSocket model as
 * proxy.test.ts), so the scheme branch in pool.establishAndStore is the only
 * thing that can make them pass: a local plain-http fixture server must
 * complete a 200 round-trip, gzip must decode, the connection must be reused
 * keep-alive style, and an http:// target through a CONNECT proxy must tunnel
 * first and then speak plaintext HTTP/1.1 inside the tunnel.
 */

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import type { ConnectOptions, DnsResolver, Net, Socket } from "@browsercore/contracts";
import { createClient } from "../src/client.js";
import { compression } from "./helpers/test-compression.js";
import { stubEvents } from "./helpers/test-platform.js";

// ---------------------------------------------------------------------------
// Fake socket plumbing — a callback-based contracts Socket whose bytes feed a
// pull-style server endpoint (the "local plain-http fixture").
// ---------------------------------------------------------------------------

/** A chunk of bytes the client wrote, in arrival order. */
interface InputChunk {
    readonly data: Uint8Array;
    readonly closed: boolean;
}

/**
 * The server-facing side of a fake connection: a waitable stream of the
 * client's writes plus a channel to respond. Mirrors the dataWaiters model of
 * the scripted servers in fetch.test.ts / fetch-seam-decompression.test.ts.
 */
class ServerEndpoint {
    private readonly pending: InputChunk[] = [];
    private waiter: ((chunk: InputChunk) => void) | undefined;

    /** Called by the client socket on every write. */
    public deliver(data: Uint8Array): void {
        this.settle({ data, closed: false });
    }

    /** Called when the client destroys the connection. */
    public markClosed(): void {
        this.settle({ data: new Uint8Array(0), closed: true });
    }

    /** Await the next chunk; resolves `{ closed: true }` once the link is gone. */
    public read(): Promise<InputChunk> {
        const buffered = this.pending.shift();
        if (buffered !== undefined) {
            return Promise.resolve(buffered);
        }
        return new Promise<InputChunk>((resolve) => {
            this.waiter = resolve;
        });
    }

    private settle(chunk: InputChunk): void {
        const waiter = this.waiter;
        this.waiter = undefined;
        if (waiter !== undefined) {
            waiter(chunk);
        } else {
            this.pending.push(chunk);
        }
    }
}

/** A contracts Socket bridging the transport to a {@link ServerEndpoint}. */
class FakeNetSocket implements Socket {
    public destroyed = false;
    public readonly server = new ServerEndpoint();

    constructor() {
        // The transport attaches its `once("connect")` listener synchronously
        // after net.connect returns; signal the completed TCP handshake on the
        // next microtask so it is registered by then.
        queueMicrotask(() => {
            this.emitCustom("connect");
        });
    }

    public write(data: Uint8Array, cb?: (err?: Error | null) => void): boolean {
        this.server.deliver(data);
        if (cb !== undefined) {
            // Real sockets fire the write callback asynchronously —
            // TcpTransport's write path relies on that ordering (its
            // `wroteOk` const is initialized only after socket.write returns).
            queueMicrotask(() => cb(null));
        }
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
        this.server.markClosed();
        if (error !== undefined) {
            this.emitCustom("error", error);
        }
        this.emitCustom("close", true);
    }

    // The `(...args: never[])` parameter is the bottom-type listener slot —
    // by contravariance it accepts every real listener shape the transport
    // registers. EventEmitter's own slot is `(...args: any[])`, which a
    // never-args value does not satisfy, so the delegation widens the claim
    // to unknown-args (sound: the emitter invokes the listener with exactly
    // the args it was given).
    public once(event: string, listener: (...args: never[]) => void): void {
        this.eventSurface.once(event, listener as (...args: unknown[]) => void);
    }

    public on(event: string, listener: (...args: never[]) => void): void {
        this.eventSurface.on(event, listener as (...args: unknown[]) => void);
    }

    /** Test seam: deliver bytes as if they arrived from the network. */
    public pushData(chunk: Uint8Array): void {
        this.emitCustom("data", chunk);
    }

    /** Test seam: fire an arbitrary event at registered listeners. */
    public emitCustom(event: string, ...args: unknown[]): void {
        this.eventSurface.emit(event, ...(args as never[]));
    }

    // EventEmitter satisfies the listener-registration surface the transport
    // uses (once/on for connect/data/close/error) without re-implementing it.
    private readonly eventSurface = new EventEmitter();
}

/**
 * A Net adapter that counts dials and hands each connection a fresh paired
 * socket. `onConnect` wires a fixture server to every dial.
 */
class FixtureNet implements Net {
    public dialCount = 0;

    public constructor(private readonly onConnect: (socket: FakeNetSocket) => void) {}

    public connect(options: ConnectOptions): Socket {
        void options;
        this.dialCount += 1;
        const socket = new FakeNetSocket();
        this.onConnect(socket);
        return socket;
    }
}

/** A DNS stub that resolves every hostname to the loopback fixture. */
const fixtureDns: DnsResolver = {
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
};

/** A parsed plain-HTTP request the fixture server hands to its handler. */
interface PlainHttpRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: ReadonlyMap<string, string>;
}

/** A scripted plain-HTTP response. */
interface PlainHttpResponse {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
}

/** Concatenate byte arrays. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Decode bytes as ASCII. */
function decodeAscii(buf: Uint8Array): string {
    let out = "";
    for (const byte of buf) out += String.fromCharCode(byte);
    return out;
}

/**
 * A keep-alive HTTP/1.1 fixture server over a fake socket: parses each
 * request head sequentially off the byte stream and answers through the
 * scripted handler. Records every request it served.
 */
class PlainHttpFixture {
    public readonly requests: PlainHttpRequest[] = [];
    // Bare `Uint8Array` (ArrayBufferLike) — concatBytes may back the result
    // with a view over a larger buffer, not a standalone ArrayBuffer.
    private buffer: Uint8Array = new Uint8Array(0);

    public constructor(socket: FakeNetSocket, private readonly handler: (req: PlainHttpRequest) => PlainHttpResponse) {
        void this.loop(socket);
    }

    private async loop(socket: FakeNetSocket): Promise<void> {
        for (;;) {
            const chunk = await socket.server.read();
            if (chunk.closed) {
                return;
            }
            this.buffer = concatBytes([this.buffer, chunk.data]);
            const parsed = this.parseBufferedRequest();
            if (parsed === undefined) {
                continue;
            }
            this.requests.push(parsed.request);
            socket.pushData(this.serializeResponse(parsed.request.method, this.handler(parsed.request)));
            this.buffer = this.buffer.slice(parsed.consumed);
        }
    }

    /** Parse one complete request head out of the buffer, if it is there. */
    private parseBufferedRequest(): { request: PlainHttpRequest; consumed: number } | undefined {
        const text = decodeAscii(this.buffer);
        const headerEnd = text.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
            return undefined;
        }
        const lines = text.slice(0, headerEnd).split("\r\n");
        const [method, url] = (lines[0] ?? "").split(" ");
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
            const idx = line.indexOf(":");
            if (idx === -1) continue;
            headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
        }
        return {
            request: { method: method ?? "", url: url ?? "", headers },
            consumed: headerEnd + 4,
        };
    }

    /** Serialize a response head + body (content-length framed, keep-alive). */
    private serializeResponse(method: string, resp: PlainHttpResponse): Uint8Array {
        // HEAD responses carry the headers but no body bytes.
        const body = method === "HEAD" ? new Uint8Array(0) : resp.body;
        const headers: Record<string, string> = { "content-length": String(resp.body.length) };
        for (const [name, value] of Object.entries(resp.headers ?? {})) {
            headers[name] = value;
        }
        let text = `HTTP/1.1 ${resp.status} OK\r\n`;
        for (const [name, value] of Object.entries(headers)) {
            text += `${name}: ${value}\r\n`;
        }
        text += "\r\n";
        return concatBytes([new TextEncoder().encode(text), body]);
    }
}

/** gzip-compress a fixture body. */
function gzipped(text: string): Uint8Array {
    return new Uint8Array(gzipSync(new TextEncoder().encode(text)));
}

/** Poll until `predicate` holds; fails the test after a generous budget. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`timed out waiting for: ${what}`);
}

/** Client options wired to the fake Net/DNS fixture (no crypto — http: needs none). */
function fixtureClientOptions(net: Net): { net: Net; dns: DnsResolver; events: ReturnType<typeof stubEvents>; compression: typeof compression } {
    return { net, dns: fixtureDns, events: stubEvents(), compression };
}

// ---------------------------------------------------------------------------
// 1. Direct plain-http dial
// ---------------------------------------------------------------------------

describe("fetch plain http:// — direct dial (#78)", () => {
    it("completes a 200 round-trip speaking plaintext HTTP/1.1 — no TLS wrap", async () => {
        let fixture: PlainHttpFixture | undefined;
        const net = new FixtureNet((socket) => {
            fixture = new PlainHttpFixture(socket, () => ({
                status: 200,
                headers: { "content-type": "text/plain" },
                body: new TextEncoder().encode("plain hello"),
            }));
        });
        const client = createClient(fixtureClientOptions(net));
        try {
            const response = await client.fetch("http://fixture.origin/hello");
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("plain hello");
            // The request on the wire was plaintext HTTP/1.1 origin-form.
            expect(fixture?.requests[0]?.method).toBe("GET");
            expect(fixture?.requests[0]?.url).toBe("/hello");
            expect(fixture?.requests[0]?.headers.get("host")).toBe("fixture.origin");
        } finally {
            await client.close();
        }
    });

    it("decompresses a gzip response over the plain-http dial", async () => {
        const net = new FixtureNet((socket) => {
            new PlainHttpFixture(socket, () => ({
                status: 200,
                headers: { "content-encoding": "gzip" },
                body: gzipped("gzipped plain-http payload"),
            }));
        });
        const client = createClient(fixtureClientOptions(net));
        try {
            const response = await client.fetch("http://fixture.origin/gz");
            expect(response.status).toBe(200);
            expect(response.headers["content-encoding"]).toBe("gzip");
            expect(await response.text()).toBe("gzipped plain-http payload");
        } finally {
            await client.close();
        }
    });

    it("reuses one keep-alive connection for repeated plain-http requests", async () => {
        const net = new FixtureNet((socket) => {
            new PlainHttpFixture(socket, () => ({ status: 200, body: new TextEncoder().encode("ka") }));
        });
        const client = createClient(fixtureClientOptions(net));
        try {
            const first = await client.fetch("http://fixture.origin/one");
            const second = await client.fetch("http://fixture.origin/two");
            expect(await first.text()).toBe("ka");
            expect(await second.text()).toBe("ka");
            // Keep-alive: both requests rode one dialled connection.
            expect(net.dialCount).toBe(1);
        } finally {
            await client.close();
        }
    });

    it("isolates connections sharing one platform event bus — a close never cross-talks (#78)", async () => {
        // The plain-http dial must construct its transport with a PRIVATE
        // event bus: a TcpTransport's event surface is the EventProvider it
        // was built with, so wiring the shared platform bus would deliver
        // connection A's `close` to connection B's HTTP/1.1 layer and kill
        // B's in-flight request. Ordering that exposes the bug: B's request
        // is in flight (B's http1 subscribed to the bus) BEFORE A closes.
        const sharedEvents = stubEvents();
        const requestOrder: string[] = [];
        // The second request's response is HELD until the first client's
        // close has landed — exactly the cross-talk window.
        let releaseSecond: (() => void) | undefined;
        const secondResponds = new Promise<void>((resolve) => {
            releaseSecond = resolve;
        });
        const net = new FixtureNet((socket) => {
            void (async () => {
                let buffer = "";
                for (;;) {
                    const chunk = await socket.server.read();
                    if (chunk.closed) return;
                    buffer += decodeAscii(chunk.data);
                    const end = buffer.indexOf("\r\n\r\n");
                    if (end === -1) continue;
                    const head = buffer.slice(0, end);
                    buffer = buffer.slice(end + 4);
                    requestOrder.push(head.split("\r\n")[0] ?? "");
                    if (requestOrder.length === 1) {
                        socket.pushData(new TextEncoder().encode("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
                        continue;
                    }
                    await secondResponds;
                    socket.pushData(new TextEncoder().encode("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
                }
            })();
        });
        const options = { net, dns: fixtureDns, events: sharedEvents, compression };

        const first = createClient(options);
        const firstResponse = await first.fetch("http://fixture.origin/first");
        expect(await firstResponse.text()).toBe("ok");

        const second = createClient(options);
        const secondPending = second.fetch("http://fixture.origin/second");
        // Wait until B's request bytes arrived — its http1 connection is now
        // live and subscribed, waiting only for the held response.
        await waitFor(() => requestOrder.length >= 2, "second request in flight");
        // A closes while B's request is in flight: A's transport `close`
        // must land on A's OWN bus, never on the shared platform bus.
        await first.close();
        releaseSecond?.();
        const secondResponse = await secondPending;
        expect(await secondResponse.text()).toBe("ok");
        await second.close();
    });
});

// ---------------------------------------------------------------------------
// 2. Plain http:// through a CONNECT proxy
// ---------------------------------------------------------------------------

describe("fetch plain http:// — through a local CONNECT proxy (#78)", () => {
    it("tunnels via CONNECT for the origin, then speaks plaintext HTTP/1.1 over the tunnel", async () => {
        const connectLines: string[] = [];
        const tunneledRequests: string[] = [];
        const net = new FixtureNet((socket) => {
            void (async () => {
                let buffer = "";
                let tunnelEstablished = false;
                for (;;) {
                    const chunk = await socket.server.read();
                    if (chunk.closed) return;
                    buffer += decodeAscii(chunk.data);
                    if (!tunnelEstablished) {
                        const end = buffer.indexOf("\r\n\r\n");
                        if (end === -1) continue;
                        connectLines.push(buffer.slice(0, end));
                        buffer = buffer.slice(end + 4);
                        tunnelEstablished = true;
                        socket.pushData(new TextEncoder().encode("HTTP/1.1 200 Connection established\r\n\r\n"));
                        continue;
                    }
                    // Post-tunnel bytes: plaintext HTTP/1.1 requests. Answer
                    // each complete head with a framed keep-alive response.
                    const end = buffer.indexOf("\r\n\r\n");
                    if (end === -1) continue;
                    tunneledRequests.push(buffer.slice(0, end));
                    buffer = buffer.slice(end + 4);
                    const body = new TextEncoder().encode("via tunnel");
                    socket.pushData(
                        new TextEncoder().encode(
                            `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n${decodeAscii(body)}`,
                        ),
                    );
                }
            })();
        });
        const client = createClient({
            ...fixtureClientOptions(net),
            proxy: { scheme: "http", host: "proxy.fixture", port: 8888 },
        });
        try {
            const response = await client.fetch("http://tunneled.origin/proxied");
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("via tunnel");
            // The proxy saw a CONNECT for the ORIGIN on its default plain port.
            expect(connectLines[0] ?? "").toContain("CONNECT tunneled.origin:80 HTTP/1.1");
            // The request inside the tunnel was plaintext origin-form h1 with
            // an http host header — not TLS bytes.
            expect(tunneledRequests[0] ?? "").toContain("GET /proxied HTTP/1.1");
            expect(tunneledRequests[0] ?? "").toContain("host: tunneled.origin");
        } finally {
            await client.close();
        }
    });

    it("never shares the tunneled plain-http connection with the direct one (proxy keys the pool)", async () => {
        const net = new FixtureNet((socket) => {
            void (async () => {
                let tunnelEstablished = false;
                for (;;) {
                    const chunk = await socket.server.read();
                    if (chunk.closed) return;
                    const text = decodeAscii(chunk.data);
                    if (!tunnelEstablished && text.startsWith("CONNECT")) {
                        socket.pushData(new TextEncoder().encode("HTTP/1.1 200 Connection established\r\n\r\n"));
                        tunnelEstablished = true;
                        continue;
                    }
                    const body = new TextEncoder().encode("ok");
                    socket.pushData(
                        new TextEncoder().encode(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\nok`),
                    );
                }
            })();
        });
        // No client-level proxy: the first request dials direct, the second
        // carries the proxy per-request — the two must pool under different
        // keys (origin vs origin+proxy identity), like the https path today.
        const client = createClient(fixtureClientOptions(net));
        const proxy = { scheme: "http" as const, host: "proxy.fixture", port: 8888 };
        try {
            const direct = await client.fetch("http://direct.origin/a");
            const proxied = await client.fetch("http://direct.origin/b", { proxy });
            expect(await direct.text()).toBe("ok");
            expect(await proxied.text()).toBe("ok");
            // Two dials: the direct connection and the proxied one never share.
            expect(net.dialCount).toBe(2);
        } finally {
            await client.close();
        }
    });
});
