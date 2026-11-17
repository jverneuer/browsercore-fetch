/**
 * Seam-path content-encoding tests (#76).
 *
 * `establishHttp1OverTransport` (the transportFactory dial) must thread the
 * resolved compression provider into http1 as `decompressionProvider` with the
 * SAME options/platform resolution the real TLS path consumes — otherwise
 * gzip/deflate/br responses arrive still-compressed over the seam. These tests
 * drive createClient end-to-end over an in-memory paired transport (the
 * fake-server pattern from fetch.test.ts) against a real, unmocked
 * connectHttp1, so the provider must survive the full client → pool → dispatch
 * → http1 threading to decode anything.
 */

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import { ContentEncodingError } from "@browsercore/http1";
import { createClient } from "../src/client.js";
import { FetchError } from "../src/index.js";
import { compression } from "./helpers/test-compression.js";
import { createTestPlatform, stubEvents } from "./helpers/test-platform.js";

// The transportFactory seam bypasses the real-TCP path, so only an event
// provider is required. Deliberately NO crypto anywhere below: the seam dial
// must not need it, and its absence is what starved the seam of the
// compression provider before the fix.
const events = stubEvents();

// ---------------------------------------------------------------------------
// In-memory fixture: a duplex FakeTransport pair plus a scripted HTTP/1.1
// server, copied in spirit from fetch.test.ts (including the queueMicrotask
// delivery guard the http1 read loop relies on).
// ---------------------------------------------------------------------------

/** Minimal parsed request the scripted server hands to its handler. */
interface SeamRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: ReadonlyMap<string, string>;
}

/** Raw HTTP/1.1 response the handler returns. */
interface SeamResponse {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
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
     * The emit (and pending-read wake-up) is deferred with `queueMicrotask` so
     * the http1 read loop has a chance to push its waiter first — without this,
     * the synchronous delivery wakes the waiter before the loop awaits its
     * read, and the buffered bytes sit forever.
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
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
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

/** Try to parse one request head (these tests send body-less GETs), or null. */
function tryParseRequestHead(buf: Uint8Array): { request: SeamRequest; consumed: number } | null {
    const headerEnd = findHeaderEnd(buf);
    if (headerEnd === -1) return null;
    const headerText = decodeAscii(buf, 0, headerEnd);
    const firstLineEnd = headerText.indexOf("\r\n");
    const requestLine = headerText.slice(0, firstLineEnd === -1 ? headerText.length : firstLineEnd);
    const parts = requestLine.split(" ");
    const headers = new Map<string, string>();
    for (const line of headerText.slice(firstLineEnd + 2).split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
    }
    return {
        request: { method: parts[0] ?? "", url: parts[1] ?? "", headers },
        consumed: headerEnd + 4,
    };
}

/** Serialize a {@link SeamResponse} into raw HTTP/1.1 bytes (content-length added). */
function serializeResponse(resp: SeamResponse): Uint8Array {
    const bodyBytes = resp.body ?? new Uint8Array(0);
    const headers: Record<string, string> = { "content-length": String(bodyBytes.length) };
    if (resp.headers !== undefined) {
        for (const [k, v] of Object.entries(resp.headers)) headers[k] = v;
    }
    let text = `HTTP/1.1 ${resp.status} OK\r\n`;
    for (const [k, v] of Object.entries(headers)) text += `${k}: ${v}\r\n`;
    text += "\r\n";
    const headerBytes = new TextEncoder().encode(text);
    const out = new Uint8Array(headerBytes.length + bodyBytes.length);
    out.set(headerBytes, 0);
    out.set(bodyBytes, headerBytes.length);
    return out;
}

/**
 * A scripted keep-alive HTTP/1.1 server: reads each request head off its
 * transport, hands it to the handler, writes the handler's response back.
 */
class FakeHttpServer {
    private buffer: Uint8Array = new Uint8Array(0);
    private readonly dataWaiters: Array<() => void> = [];
    private closed = false;

    constructor(
        private readonly transport: FakeTransport,
        private readonly handler: (req: SeamRequest) => SeamResponse,
    ) {
        transport.on("data", (chunk: Uint8Array) => {
            const merged = new Uint8Array(this.buffer.length + chunk.length);
            merged.set(this.buffer, 0);
            merged.set(chunk, this.buffer.length);
            this.buffer = merged;
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
            await this.transport.write(serializeResponse(this.handler(req)));
        }
    }

    private nextRequest(): Promise<SeamRequest | undefined> {
        return new Promise<SeamRequest | undefined>((resolve) => {
            const tryResolve = (): void => {
                const parsed = tryParseRequestHead(this.buffer);
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

/**
 * Install a `transportFactory` backend: every dialed origin gets a fresh
 * paired transport whose server side runs the scripted handler. Records the
 * requests seen and the transports created so tests can pin keep-alive reuse.
 */
function installSeamBackend(handler: (req: SeamRequest) => SeamResponse): {
    factory: (host: string, port: number) => Transport;
    requests: SeamRequest[];
    serverTransports: FakeTransport[];
    close: () => Promise<void>;
} {
    const requests: SeamRequest[] = [];
    const serverTransports: FakeTransport[] = [];
    const factory = (host: string, port: number): Transport => {
        void host;
        void port;
        const { client, server } = FakeTransport.pair();
        serverTransports.push(server);
        new FakeHttpServer(server, (req) => {
            requests.push(req);
            return handler(req);
        });
        return client;
    };
    return {
        factory,
        requests,
        serverTransports,
        close: async () => {
            for (const t of serverTransports) await t.close();
        },
    };
}

/** Encode `text` with the given wire codec, for scripted compressed bodies. */
function encodedBody(text: string, encoding: "gzip" | "deflate" | "br"): Uint8Array {
    const raw = new TextEncoder().encode(text);
    switch (encoding) {
        case "gzip":
            return new Uint8Array(gzipSync(raw));
        case "deflate":
            return new Uint8Array(deflateSync(raw));
        case "br":
            return new Uint8Array(brotliCompressSync(raw));
    }
}

describe("fetch over the transport seam — content-encoding (#76)", () => {
    it("decompresses a gzip response over the seam (provider injected directly, no crypto)", async () => {
        // The regression shape of #76 exactly: compression without crypto.
        // Before the fix the provider was gated on crypto at pool-options
        // assembly AND dropped by the seam dial — the body arrived as raw
        // gzip bytes.
        const { factory, close } = installSeamBackend(() => ({
            status: 200,
            headers: { "content-encoding": "gzip" },
            body: encodedBody("seam gzip payload", "gzip"),
        }));
        const client = createClient({ transportFactory: factory, compression, events });
        try {
            const response = await client.fetch("http://example.com/gz");
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("seam gzip payload");
        } finally {
            await client.close();
            await close();
        }
    });

    it("decompresses a deflate response over the seam (zlib-wrapped)", async () => {
        const { factory, close } = installSeamBackend(() => ({
            status: 200,
            headers: { "content-encoding": "deflate" },
            body: encodedBody("seam deflate payload", "deflate"),
        }));
        const client = createClient({ transportFactory: factory, compression, events });
        try {
            const response = await client.fetch("http://example.com/df");
            expect(await response.text()).toBe("seam deflate payload");
        } finally {
            await client.close();
            await close();
        }
    });

    it("decompresses a brotli response over the seam", async () => {
        const { factory, close } = installSeamBackend(() => ({
            status: 200,
            headers: { "content-encoding": "br" },
            body: encodedBody("seam brotli payload", "br"),
        }));
        const client = createClient({ transportFactory: factory, compression, events });
        try {
            const response = await client.fetch("http://example.com/br");
            expect(await response.text()).toBe("seam brotli payload");
        } finally {
            await client.close();
            await close();
        }
    });

    it("resolves the provider from platform.compression when no direct option is given", async () => {
        // Same options/platform → compression resolution the real TLS path
        // uses; the seam must consume the identical resolution.
        const { factory, close } = installSeamBackend(() => ({
            status: 200,
            headers: { "content-encoding": "gzip" },
            body: encodedBody("platform-resolved payload", "gzip"),
        }));
        const client = createClient({ transportFactory: factory, platform: createTestPlatform() });
        try {
            const response = await client.fetch("http://example.com/platform");
            expect(await response.text()).toBe("platform-resolved payload");
        } finally {
            await client.close();
            await close();
        }
    });

    it("rejects with the documented ContentEncodingError when no provider is injected", async () => {
        // Unchanged semantics: absent in options AND platform stays absent —
        // http1 raises ContentEncodingError rather than returning corrupt
        // bytes, and the client surfaces it as a FetchError with the original
        // as cause.
        const { factory, close } = installSeamBackend(() => ({
            status: 200,
            headers: { "content-encoding": "gzip" },
            body: encodedBody("never decoded", "gzip"),
        }));
        const client = createClient({ transportFactory: factory, events });
        let caught: unknown;
        try {
            await client.fetch("http://example.com/no-provider");
        } catch (err) {
            caught = err;
        } finally {
            await client.close();
            await close();
        }
        expect(caught).toBeInstanceOf(FetchError);
        const fetchError = caught as FetchError;
        expect(fetchError.message).toContain("Unsupported or corrupt content-encoding: gzip");
        expect(fetchError.cause).toBeInstanceOf(ContentEncodingError);
        expect((fetchError.cause as ContentEncodingError).encoding).toBe("gzip");
    });

    it("passes an identity response through unchanged when a provider is present", async () => {
        // No behavior change for unencoded bodies: the provider is available
        // but never invoked (no content-encoding header → nothing to decode).
        const { factory, close } = installSeamBackend(() => ({
            status: 200,
            body: new TextEncoder().encode("plain identity body"),
        }));
        const client = createClient({ transportFactory: factory, compression, events });
        try {
            const response = await client.fetch("http://example.com/identity");
            expect(response.headers["content-encoding"]).toBeUndefined();
            expect(await response.text()).toBe("plain identity body");
        } finally {
            await client.close();
            await close();
        }
    });

    it("decodes every response on a reused seam connection (provider threads at dial time)", async () => {
        // The provider is a property of the pooled http1 connection, not of a
        // single request: a second fetch over the same seam transport must
        // decode too, with the factory called exactly once.
        const { factory, requests, serverTransports, close } = installSeamBackend(() => ({
            status: 200,
            headers: { "content-encoding": "gzip" },
            body: encodedBody("reused seam payload", "gzip"),
        }));
        const client = createClient({ transportFactory: factory, compression, events });
        try {
            const first = await client.fetch("http://example.com/reuse");
            expect(await first.text()).toBe("reused seam payload");
            const second = await client.fetch("http://example.com/reuse");
            expect(await second.text()).toBe("reused seam payload");
            expect(requests).toHaveLength(2);
            expect(serverTransports).toHaveLength(1);
        } finally {
            await client.close();
            await close();
        }
    });
});
