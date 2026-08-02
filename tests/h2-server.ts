/**
 * In-process fake HTTP/2 server for fetch behavioral tests.
 *
 * The fetch client's `tlsFactory` seam (see FetchClientOptions) lets tests
 * bypass the not-yet-finished TLS layer by injecting a fake TlsConnection
 * whose `alpnProtocol` reports `"h2"`. On the other side of the paired
 * in-memory transport, this server speaks just enough of HTTP/2 to complete
 * the connection preface and serve a scripted request:
 *
 *   1. Consume the 24-byte client connection preface.
 *   2. On the client's SETTINGS frame, reply with our own SETTINGS frame +
 *      a SETTINGS ACK — the latter unblocks the client's
 *      `waitForSettingsAck()`.
 *   3. On the request HEADERS frame, decode the request, hand it to the
 *      handler, and respond with response HEADERS (+ END_HEADERS) followed
 *      by a DATA frame carrying the body (+ END_STREAM).
 *
 * It uses @browsercore/http2's own frame + HPACK utilities so the bytes on
 * the wire are exactly what a real peer would emit.
 */

import { EventEmitter } from "node:events";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import {
    FRAME_HEADER_LENGTH,
    decodeHeaders,
    encodeHeaders,
    parseFrame,
    parseFrameHeader,
    serializeFrame,
} from "@browsercore/http2";
import type { Frame, Http2StreamId } from "@browsercore/http2";
import type {
    CipherSuite,
    ProtocolVersion,
    TlsConnection,
    TlsSessionId,
    TlsState,
} from "@browsercore/tls";

/** Minimal parsed HTTP/2 request the fake server hands to its handler. */
export interface H2FakeRequest {
    readonly method: string;
    readonly path: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Uint8Array;
}

/** Raw HTTP/2 response the handler returns. */
export interface H2FakeResponse {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array | string;
}

/** A duplex in-memory transport (same model as the test's FakeTransport). */
class H2FakeTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    private _state: TransportState = { state: "open" };
    private _peer: H2FakeTransport | undefined;
    private readonly _readBuffer: number[] = [];
    private _pendingRead: ((data: Uint8Array) => void) | undefined;
    private _pendingReadReject: ((err: Error) => void) | undefined;

    private constructor(id: string) {
        super();
        this.id = id as TransportId;
    }

    public static pair(): { client: H2FakeTransport; server: H2FakeTransport } {
        const client = new H2FakeTransport("client");
        const server = new H2FakeTransport("server");
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
        const peer = this._peer;
        if (peer !== undefined && peer._state.state !== "closed") {
            peer._state = { state: "closed", reason: { kind: "remote_close" } };
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

    private _deliver(data: Uint8Array): void {
        for (let i = 0; i < data.length; i++) this._readBuffer.push(data[i]!);
        const buffered = Uint8Array.from(this._readBuffer);
        const pending = this._pendingRead;
        if (pending !== undefined) {
            // A read() is waiting: hand it every byte accumulated so far and
            // drain the buffer. This is the only case we clear — see below.
            this._readBuffer.length = 0;
            this._pendingRead = undefined;
            this._pendingReadReject = undefined;
        }
        // Emit "data" with only the newly arrived chunk, never the whole
        // buffer, so a push consumer (the fake HTTP/2 server) sees each byte
        // exactly once. When no read() is pending we deliberately leave the
        // bytes in _readBuffer so the next read() drains them. Without that,
        // back-to-back frames sent while the pull consumer is between reads —
        // e.g. the server's SETTINGS (27 bytes) + SETTINGS ACK (9 bytes), the
        // ACK arriving after the read loop has resolved frame #1 but before it
        // calls read() again — would be dropped: the bytes are pushed, the
        // buffer is then cleared (old behaviour), and the read loop hangs
        // waiting on an ACK that vanished.
        queueMicrotask(() => {
            this.emit("data", data);
            if (pending !== undefined) pending(buffered);
        });
    }
}

/** Concatenate two byte arrays. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * A fake TlsConnection that bridges a client-side in-memory transport to a
 * server. `adaptTlsToTransport()` in the fetch client consumes this shape.
 * The `alpnProtocol` reports the protocol the (fake) server negotiated so the
 * client's ALPN branch selects HTTP/2 or HTTP/1.1.
 *
 * It structurally satisfies {@link TlsConnection}: the `id` is a branded
 * `TlsSessionId`, `state` is a full `open` variant carrying the negotiated
 * parameters, and `on`/`read`/`write`/`close` bridge the in-memory transport.
 */
export class FakeTlsConnection extends EventEmitter implements TlsConnection {
    public readonly id: TlsSessionId;
    public readonly protocolVersion: ProtocolVersion = { name: "TLS 1.3", wire: 0x0304 };
    public readonly cipherSuite: CipherSuite = "TLS_AES_128_GCM_SHA256";
    public readonly alpnProtocol: string;
    public readonly state: TlsState;

    private readonly _transport: H2FakeTransport;

    constructor(transport: H2FakeTransport, alpnProtocol: "h2" | "http/1.1") {
        super();
        this._transport = transport;
        this.alpnProtocol = alpnProtocol;
        this.id = "tls-fake" as TlsSessionId;
        this.state = {
            state: "open",
            sessionId: this.id,
            protocolVersion: this.protocolVersion,
            cipherSuite: this.cipherSuite,
            alpnProtocol: this.alpnProtocol,
        };
    }

    public write(data: Uint8Array): Promise<void> {
        return this._transport.write(data);
    }

    public async read(): Promise<{ payload: Uint8Array }> {
        const data = await this._transport.read();
        return { payload: data };
    }

    public close(): Promise<void> {
        return this._transport.close();
    }
}

/** The fixed client connection preface string (RFC 7540 §3.5). */
const CLIENT_PREFACE = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

/** A scripted in-memory HTTP/2 server. */
export class FakeHttp2Server {
    private buffer: Uint8Array = new Uint8Array(0);
    private prefaceConsumed = false;
    private requestStreamId: Http2StreamId | undefined;
    private readonly dataWaiters: Array<() => void> = [];
    private closed = false;

    constructor(
        private readonly transport: H2FakeTransport,
        private readonly handler: (req: H2FakeRequest) => H2FakeResponse,
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
            const frame = await this.readFrame();
            if (frame === undefined) return;
            this.handleFrame(frame);
        }
    }

    /** Read exactly one frame (after the preface), or `undefined` if closed. */
    private readFrame(): Promise<Frame | undefined> {
        return new Promise<Frame | undefined>((resolve) => {
            const tryResolve = (): void => {
                if (!this.prefaceConsumed) {
                    if (this.buffer.length < CLIENT_PREFACE.length) {
                        if (this.closed) {
                            resolve(undefined);
                            return;
                        }
                        this.dataWaiters.push(() => tryResolve());
                        return;
                    }
                    this.buffer = this.buffer.slice(CLIENT_PREFACE.length);
                    this.prefaceConsumed = true;
                }
                if (this.buffer.length < FRAME_HEADER_LENGTH) {
                    if (this.closed) {
                        resolve(undefined);
                        return;
                    }
                    this.dataWaiters.push(() => tryResolve());
                    return;
                }
                const header = parseFrameHeader(this.buffer);
                const total = FRAME_HEADER_LENGTH + header.length;
                if (this.buffer.length < total) {
                    if (this.closed) {
                        resolve(undefined);
                        return;
                    }
                    this.dataWaiters.push(() => tryResolve());
                    return;
                }
                const frame = parseFrame(this.buffer.subarray(0, total));
                this.buffer = this.buffer.slice(total);
                resolve(frame);
            };
            tryResolve();
        });
    }

    private handleFrame(frame: Frame): void {
        switch (frame.type) {
            case 0x4: // SETTINGS
                if (!frame.ack) {
                    // Advertise our own limits, then ACK the client's settings so
                    // its waitForSettingsAck() resolves.
                    this.writeFrame({
                        type: 0x4,
                        flags: 0,
                        streamId: 0 as Http2StreamId,
                        ack: false,
                        settings: {
                            // HEADER_TABLE_SIZE
                            0x1: 65536,
                            // MAX_CONCURRENT_STREAMS
                            0x3: 100,
                            // MAX_FRAME_SIZE
                            0x5: 16384,
                        },
                    });
                    this.writeFrame({
                        type: 0x4,
                        flags: 0x1, // ACK
                        streamId: 0 as Http2StreamId,
                        ack: true,
                        settings: {},
                    });
                }
                return;
            case 0x1: { // HEADERS — the request (client streams are odd: 1, 3, …).
                const headers = decodeHeaders(frame.payload);
                const method = headers.get(":method") ?? "GET";
                const path = headers.get(":path") ?? "/";
                this.requestStreamId = frame.streamId;
                const resp = this.handler({ method, path, headers, body: new Uint8Array(0) });
                this.sendResponse(frame.streamId, resp);
                return;
            }
            case 0x0: { // DATA — request body (e.g. POST). Buffer for the handler.
                // The handler was already invoked on HEADERS; for simplicity we
                // ignore trailing body bytes here (GET tests need none).
                const endStream = (frame.flags & 0x1) !== 0;
                if (endStream && this.requestStreamId !== undefined) {
                    // No-op: response already sent.
                }
                return;
            }
            case 0x6: // PING
                if (!frame.ack) {
                    this.writeFrame({
                        type: 0x6,
                        flags: 0x1, // ACK
                        streamId: 0 as Http2StreamId,
                        ack: true,
                        opaqueData: frame.opaqueData,
                    });
                }
                return;
            case 0x8: // WINDOW_UPDATE — client replenishing our send credit. Ignore.
            case 0x3: // RST_STREAM
            case 0x7: // GOAWAY
            case 0x2: // PRIORITY
            case 0x9: // CONTINUATION
            case 0x5: // PUSH_PROMISE
                return;
            default:
                // Unknown frame types MUST be ignored per RFC 7540 §4.1.
                return;
        }
    }

    private sendResponse(streamId: Http2StreamId, resp: H2FakeResponse): void {
        const bodyBytes =
            resp.body === undefined
                ? new Uint8Array(0)
                : typeof resp.body === "string"
                  ? new TextEncoder().encode(resp.body)
                  : resp.body;
        const headers = new Map<string, string>();
        headers.set(":status", String(resp.status));
        if (resp.headers !== undefined) {
            for (const [k, v] of Object.entries(resp.headers)) headers.set(k, v);
        }
        const payload = encodeHeaders(headers);
        // Response HEADERS with END_HEADERS (no END_STREAM — body follows).
        this.writeFrame({
            type: 0x1,
            flags: 0x4, // END_HEADERS
            streamId,
            endHeaders: true,
            endStream: false,
            padded: false,
            payload,
        });
        // Response DATA with END_STREAM.
        this.writeFrame({
            type: 0x0,
            flags: 0x1, // END_STREAM
            streamId,
            payload: bodyBytes,
        });
    }

    private writeFrame(frame: Frame): void {
        const bytes = serializeFrame(frame);
        void this.transport.write(bytes);
    }
}

/**
 * Build a `tlsFactory` + fake HTTP/2 server for the fetch client. Each origin
 * gets its own paired transport; every server transport is wired to the same
 * handler so a redirect to a "second origin" still reaches the scripted
 * backend. Pass `protocol: "http/1.1"` to exercise the HTTP/1.1 ALPN branch
 * against the existing FakeHttpServer (not provided here).
 */
export function installFakeH2Backend(handler: (req: H2FakeRequest) => H2FakeResponse): {
    factory: (host: string, port: number) => FakeTlsConnection;
    clientTransports: H2FakeTransport[];
    close: () => Promise<void>;
} {
    const clientTransports: H2FakeTransport[] = [];
    const factory = (host: string, port: number): FakeTlsConnection => {
        void host;
        void port;
        const { client, server } = H2FakeTransport.pair();
        clientTransports.push(client);
        new FakeHttp2Server(server, handler);
        return new FakeTlsConnection(client, "h2");
    };
    return {
        factory,
        clientTransports,
        close: async () => {
            for (const t of clientTransports) await t.close();
        },
    };
}
