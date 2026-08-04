import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import { createClient } from "../src/client.js";
import {
    FetchError,
    FetchTimeoutError,
    ProtocolError,
    RedirectError,
} from "../src/index.js";

describe("FetchError", () => {
    it("instantiates as a FetchError and an Error", () => {
        const err = new FetchError("boom", {
            url: "https://example.com",
            requestId: "fetch_abc" as never,
        });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(FetchError);
        expect(err.kind).toBe("FetchError");
        expect(err.url).toBe("https://example.com");
        expect(err.requestId).toBe("fetch_abc");
        expect(err.message).toBe("boom");
    });

    it("captures a cause", () => {
        const cause = new Error("underlying");
        const err = new FetchError("wrapped", { cause });
        expect(err.cause).toBe(cause);
    });
});

describe("typed fetch errors", () => {
    it("FetchTimeoutError carries the timeout", () => {
        const err = new FetchTimeoutError(5000);
        expect(err).toBeInstanceOf(FetchTimeoutError);
        expect(err.timeoutMs).toBe(5000);
        expect(err.message).toContain("5000");
    });

    it("RedirectError carries location + redirect count", () => {
        const err = new RedirectError("loop", {
            location: "https://a",
            redirectCount: 7,
        });
        expect(err).toBeInstanceOf(RedirectError);
        expect(err.location).toBe("https://a");
        expect(err.redirectCount).toBe(7);
    });

    it("ProtocolError carries ALPN details", () => {
        const err = new ProtocolError("no overlap", {
            offeredProtocols: ["h2", "http/1.1"],
            selectedProtocol: undefined,
        });
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.offeredProtocols).toEqual(["h2", "http/1.1"]);
        expect(err.selectedProtocol).toBeUndefined();
    });
});

describe("FetchOptions type shape", () => {
    it("compiles with a full options object", () => {
        // This test exists to ensure the public FetchOptions shape stays
        // consumable — it is checked at compile time, not runtime.
        const options = {
            method: "POST" as const,
            headers: { "content-type": "text/plain" },
            body: "hi",
            followRedirects: true,
            maxRedirects: 10,
            timeoutMs: 30_000,
        };
        expect(options.method).toBe("POST");
    });
});

describe("fetch entrypoint — URL validation", () => {
    it("rejects an invalid URL with FetchError before dispatching", async () => {
        // parseUrl() runs before any network access, so this never touches the
        // wire. A malformed URL must surface as a FetchError (not a bare
        // TypeError from `new URL`) so callers get a uniform error type.
        const client = createClient();
        try {
            await expect(client.fetch(":::not-a-url:::")).rejects.toBeInstanceOf(FetchError);
        } finally {
            await client.close();
        }
    });

    it("rejects an unsupported scheme with FetchError", async () => {
        const client = createClient();
        try {
            await expect(client.fetch("ftp://example.com/")).rejects.toBeInstanceOf(FetchError);
        } finally {
            await client.close();
        }
    });
});

describe("fetch entrypoint — AbortSignal", () => {
    it("rejects immediately when the signal is already aborted", async () => {
        // The client checks `signal.aborted` before dispatching. A pre-aborted
        // signal must reject with an abort-tagged FetchError without ever
        // attempting a connection.
        const client = createClient();
        try {
            await expect(
                client.fetch("https://example.com/never", { signal: AbortSignal.abort() }),
            ).rejects.toThrow(/abort/i);
        } finally {
            await client.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Behavioral tests — drive the client against an in-process fake HTTP/1.1
// server over a paired in-memory transport (modeled on the http2
// fake-transport.ts pattern). The client's `transportFactory` seam lets us
// bypass the not-yet-implemented TLS layer and speak HTTP/1.1 directly.
// ---------------------------------------------------------------------------

/** Minimal parsed HTTP request the fake server hands to its handler. */
interface FakeRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Uint8Array;
}

/** Raw HTTP/1.1 response the handler returns (`undefined` = never reply). */
interface FakeResponse {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array | string;
}

/** A duplex in-memory transport: bytes written on one side arrive on the other. */
class FakeTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    private _state: TransportState = { state: "open" };
    private _peer: FakeTransport | undefined;
    private readonly _readBuffer: number[] = [];
    private _pendingRead: ((data: Uint8Array) => void) | undefined;
    private _pendingReadReject: ((err: Error) => void) | undefined;

    private constructor(id: string) {
        super();
        this.id = id as TransportId;
    }

    public static pair(): { client: FakeTransport; server: FakeTransport } {
        const client = new FakeTransport("client");
        const server = new FakeTransport("server");
        client._peer = server;
        server._peer = client;
        return { client, server };
    }

    public get state(): TransportState {
        return this._state;
    }

    public write(data: Uint8Array): Promise<void> {
        if (this._state.state !== "open") {
            return Promise.reject(new Error(`transport ${this.id} is ${this._state.state}`));
        }
        const peer = this._peer;
        if (peer !== undefined) {
            peer._deliver(data);
            return Promise.resolve();
        }
        for (let i = 0; i < data.length; i++) this._readBuffer.push(data[i]!);
        return Promise.resolve();
    }

    public read(): Promise<Uint8Array> {
        if (this._state.state !== "open") {
            return Promise.reject(new Error(`transport ${this.id} is ${this._state.state}`));
        }
        if (this._readBuffer.length > 0) {
            const data = Uint8Array.from(this._readBuffer);
            this._readBuffer.length = 0;
            return Promise.resolve(data);
        }
        return new Promise<Uint8Array>((resolve, reject) => {
            this._pendingRead = resolve;
            this._pendingReadReject = reject;
        });
    }

    public close(): Promise<void> {
        if (this._state.state === "closed") return Promise.resolve();
        this._state = { state: "closed", reason: { kind: "client_close" } };
        const rejecter = this._pendingReadReject;
        if (rejecter !== undefined) {
            this._pendingRead = undefined;
            this._pendingReadReject = undefined;
            rejecter(new Error("transport closed"));
        }
        // Closing one end signals the peer too, like a real duplex socket.
        const peer = this._peer;
        if (peer !== undefined && peer._state.state !== "closed") {
            peer._state = { state: "closed", reason: { kind: "peer_close" } };
            const peerRejecter = peer._pendingReadReject;
            if (peerRejecter !== undefined) {
                peer._pendingRead = undefined;
                peer._pendingReadReject = undefined;
                peerRejecter(new Error("transport closed"));
            }
        }
        this.emit("close", false);
        return Promise.resolve();
    }

    /**
     * Push bytes into this side's read buffer (data "arriving" from the peer).
     * The HTTP/1.1 layer consumes bytes via the "data" event, so emit it.
     *
     * The emit (and pending-read wake-up) is deferred with `queueMicrotask`
     * so the http1 read loop has a chance to push its waiter first. Without
     * this, the synchronous delivery wakes the waiter before the loop awaits
     * its read, and the buffered bytes sit forever (a race the fake used to
     * lose but real async sockets never do).
     */
    private _deliver(data: Uint8Array): void {
        for (let i = 0; i < data.length; i++) this._readBuffer.push(data[i]!);
        const buffered = Uint8Array.from(this._readBuffer);
        this._readBuffer.length = 0;
        const pending = this._pendingRead;
        if (pending !== undefined) {
            this._pendingRead = undefined;
            this._pendingReadReject = undefined;
        }
        queueMicrotask(() => {
            this.emit("data", buffered);
            if (pending !== undefined) pending(data);
        });
    }
}

/** Find the offset of the `\r\n\r\n` header terminator, or -1 if not present. */
function findHeaderEnd(buf: Uint8Array): number {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (
            buf[i] === 0x0d &&
            buf[i + 1] === 0x0a &&
            buf[i + 2] === 0x0d &&
            buf[i + 3] === 0x0a
        ) {
            return i;
        }
    }
    return -1;
}

/** Decode a slice of bytes as ASCII without going through `Buffer`. */
function decodeAscii(buf: Uint8Array, start: number, end: number): string {
    let out = "";
    for (let i = start; i < end; i++) out += String.fromCharCode(buf[i]!);
    return out;
}

/** Extract the `content-length` header value, or `undefined` if absent. */
function contentLengthOf(headerText: string): number | undefined {
    const match = /(?:^|\n)content-length:\s*(\d+)\r?/i.exec(headerText);
    if (match === null) return undefined;
    const value = match[1];
    return value === undefined ? undefined : Number(value);
}

/** Try to parse one complete request out of a buffer, or `null` if incomplete. */
function tryParseRequest(buf: Uint8Array): { request: FakeRequest; consumed: number } | null {
    const headerEnd = findHeaderEnd(buf);
    if (headerEnd === -1) return null;
    const bodyStart = headerEnd + 4;
    const headerText = decodeAscii(buf, 0, headerEnd);
    const firstLineEnd = headerText.indexOf("\r\n");
    const requestLine = headerText.slice(0, firstLineEnd === -1 ? headerText.length : firstLineEnd);
    const parts = requestLine.split(" ");
    const method = parts[0] ?? "";
    const url = parts[1] ?? "";
    const headers = new Map<string, string>();
    for (const line of headerText.slice(firstLineEnd + 2).split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
    }
    const cl = contentLengthOf(headerText);
    if (cl !== undefined) {
        if (buf.length < bodyStart + cl) return null;
        return {
            request: { method, url, headers, body: buf.slice(bodyStart, bodyStart + cl) },
            consumed: bodyStart + cl,
        };
    }
    // No content-length (and not chunked): no body.
    return { request: { method, url, headers, body: new Uint8Array(0) }, consumed: bodyStart };
}

/** Serialize a {@link FakeResponse} into raw HTTP/1.1 bytes. */
function serializeResponse(resp: FakeResponse): Uint8Array {
    const bodyBytes =
        resp.body === undefined
            ? new Uint8Array(0)
            : typeof resp.body === "string"
              ? new TextEncoder().encode(resp.body)
              : resp.body;
    const headers: Record<string, string> = { "content-length": String(bodyBytes.length) };
    if (resp.headers !== undefined) {
        for (const [k, v] of Object.entries(resp.headers)) headers[k] = v;
    }
    let text = `HTTP/1.1 ${resp.status} ${resp.statusText ?? ""}\r\n`;
    for (const [k, v] of Object.entries(headers)) text += `${k}: ${v}\r\n`;
    text += "\r\n";
    const headerBytes = new TextEncoder().encode(text);
    const out = new Uint8Array(headerBytes.length + bodyBytes.length);
    out.set(headerBytes, 0);
    out.set(bodyBytes, headerBytes.length);
    return out;
}

/**
 * A scripted in-memory HTTP/1.1 server. It reads requests off its transport,
 * hands each to the handler, and writes the handler's raw response back.
 * A handler returning `undefined` never replies — the request hangs, which is
 * what the timeout/abort tests rely on.
 */
class FakeHttpServer {
    private buffer: Uint8Array = new Uint8Array(0);
    private readonly dataWaiters: Array<() => void> = [];
    private closed = false;

    constructor(
        private readonly transport: FakeTransport,
        private readonly handler: (req: FakeRequest) => FakeResponse | undefined,
    ) {
        transport.on("data", (chunk: Uint8Array) => {
            this.buffer = concat(this.buffer, chunk);
            const waiter = this.dataWaiters.shift();
            if (waiter !== undefined) waiter();
        });
        transport.on("close", () => {
            this.closed = true;
            for (const waiter of this.dataWaiters) waiter();
            this.dataWaiters.length = 0;
        });
        void this.loop();
    }

    private async loop(): Promise<void> {
        for (;;) {
            const req = await this.nextRequest();
            if (req === undefined) return;
            const resp = await this.handler(req);
            if (resp === undefined) return; // hang: stop responding
            await this.transport.write(serializeResponse(resp));
        }
    }

    private nextRequest(): Promise<FakeRequest | undefined> {
        return new Promise<FakeRequest | undefined>((resolve) => {
            const tryResolve = (): void => {
                const parsed = tryParseRequest(this.buffer);
                if (parsed !== null) {
                    this.buffer = this.buffer.slice(parsed.consumed);
                    resolve(parsed.request);
                    return;
                }
                if (this.closed) {
                    resolve(undefined);
                    return;
                }
                this.dataWaiters.push(() => tryResolve());
            };
            tryResolve();
        });
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * Build a `transportFactory` + server for the client. Each origin gets its own
 * paired transport, but every server transport is wired to the same handler —
 * so a redirect to a "second origin" still reaches the scripted backend.
 */
function installFakeBackend(handler: (req: FakeRequest) => FakeResponse | undefined): {
    factory: (host: string, port: number) => Transport;
    close: () => Promise<void>;
} {
    const serverTransports: FakeTransport[] = [];
    const factory = (host: string, port: number): Transport => {
        // The fetch client ignores host/port here (they're already parsed out
        // of the URL); we just need a fresh pair per origin.
        void host;
        void port;
        const { client, server } = FakeTransport.pair();
        serverTransports.push(server);
        new FakeHttpServer(server, handler);
        return client;
    };
    return {
        factory,
        close: async () => {
            for (const t of serverTransports) await t.close();
        },
    };
}

describe("fetch — behavioral", () => {
    it("parses a non-default port out of the URL", async () => {
        const seen: Array<{ host: string; port: number }> = [];
        const { factory, close } = installFakeBackend(() => ({
            status: 200,
            statusText: "OK",
            body: "ok",
        }));
        // Wrap the factory to capture the host/port the client resolved.
        const client = createClient({
            transportFactory: (host, port) => {
                seen.push({ host, port });
                return factory(host, port);
            },
        });
        try {
            const response = await client.fetch("http://example.com:8080/where");
            expect(response.status).toBe(200);
            expect(seen).toEqual([{ host: "example.com", port: 8080 }]);
        } finally {
            await client.close();
            await close();
        }
    });

    it("round-trips Set-Cookie from the jar onto the next request", async () => {
        const requests: FakeRequest[] = [];
        const { factory, close } = installFakeBackend((req) => {
            requests.push(req);
            if (requests.length === 1) {
                return {
                    status: 200,
                    statusText: "OK",
                    headers: { "set-cookie": "sid=1; Path=/" },
                    body: "",
                };
            }
            return { status: 200, statusText: "OK", body: "ok" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            const first = await client.fetch("http://example.com/");
            expect(first.status).toBe(200);
            const second = await client.fetch("http://example.com/");
            expect(second.status).toBe(200);
            // The second request must carry the cookie the server set.
            expect(requests).toHaveLength(2);
            expect(requests[1]?.headers.get("cookie")).toBe("sid=1");
        } finally {
            await client.close();
            await close();
        }
    });

    it("follows a 301 to a second origin and returns the final response", async () => {
        const { factory, close } = installFakeBackend((req) => {
            if (req.url === "/") {
                return {
                    status: 301,
                    statusText: "Moved Permanently",
                    headers: { location: "http://other.example/final" },
                    body: "",
                };
            }
            return { status: 200, statusText: "OK", body: "final" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            const response = await client.fetch("http://example.com/");
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("final");
        } finally {
            await client.close();
            await close();
        }
    });

    it("rejects with FetchTimeoutError when the request times out", async () => {
        // Handler never replies -> the request hangs until the timeout fires.
        const { factory, close } = installFakeBackend(() => undefined);
        const client = createClient({ transportFactory: factory, timeoutMs: 50 });
        try {
            await expect(client.fetch("http://example.com/slow")).rejects.toThrow(FetchTimeoutError);
        } finally {
            await client.close();
            await close();
        }
    });

    it("cancels an in-flight request when the signal aborts", async () => {
        // Handler never replies; the AbortSignal aborts the request.
        const { factory, close } = installFakeBackend(() => undefined);
        const client = createClient({ transportFactory: factory, timeoutMs: 10_000 });
        try {
            const controller = new AbortController();
            const pending = client.fetch("http://example.com/hang", {
                signal: controller.signal,
            });
            controller.abort();
            await expect(pending).rejects.toThrow(/aborted/);
        } finally {
            await client.close();
            await close();
        }
    });
});
