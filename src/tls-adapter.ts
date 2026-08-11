/**
 * TLS → Transport adapter for @browsercore/fetch.
 *
 * The HTTP layers (http1, http2) speak to a {@link Transport} — a reliable,
 * ordered byte stream. Once TLS terminates the wire, the decrypted record stream
 * IS that byte stream, but {@link TlsConnection} exposes a different shape
 * (`ApplicationData` reads, `TlsState` lifecycle, branded `TlsSessionId`). This
 * adapter bridges the two without forcing casts: it generates its own
 * {@link TransportId}, maps TLS states to transport states via an exhaustive
 * switch, and forwards the decrypted payloads as plain `Uint8Array` chunks.
 *
 * ## Private event bus
 *
 * The adapter satisfies the {@link Transport} surface via a **private**
 * `EventEmitter`. It deliberately does NOT re-use the shared, injected
 * `EventProvider` bus. Re-using the shared bus caused an event-forwarding loop:
 * TLS emits `"error"` on the shared bus → the adapter's own `on("error")`
 * listener fires → the adapter calls `this.emit("error", …)` → the listener
 * fires again → stack overflow. With a private emitter, close/error forwarded
 * from the TLS connection land on the adapter's own bus and are observed only
 * by HTTP-layer listeners, never re-broadcast to the shared bus.
 */

import { EventEmitter } from "node:events";
import type { CloseReason as TlsCloseReasonType, TlsConnection, TlsState } from "@browsercore/tls";
import type { CloseReason, Transport, TransportId, TransportState } from "@browsercore/transport";
import { assertNever, createId } from "./utils.js";

/**
 * Adapt a {@link TlsConnection} to the {@link Transport} interface the HTTP
 * layers expect. The adapter owns its own {@link TransportId} (independent of
 * the TLS session id) and projects the TLS lifecycle onto transport states.
 *
 * The adapter's {@link Transport} event surface is backed by a **private**
 * emitter (see class header) so that close/error forwarded from the TLS
 * connection are delivered to HTTP-layer listeners without touching the shared
 * injected bus.
 */
export class TlsTransportAdapter implements Transport {
    public readonly id: TransportId;
    private readonly internalEmitter = new EventEmitter();
    private readonly tls: TlsConnection;

    // -------------------------------------------------------------------------
    // EventProvider delegation — backed by the private internal emitter, NOT
    // the shared injected bus, to prevent the close/error forwarding loop.
    // -------------------------------------------------------------------------

    public on(event: string, listener: (...args: unknown[]) => void): void {
        this.internalEmitter.on(event, listener);
    }

    public once(event: string, listener: (...args: unknown[]) => void): void {
        this.internalEmitter.once(event, listener);
    }

    public off(event: string, listener: (...args: unknown[]) => void): void {
        this.internalEmitter.off(event, listener);
    }

    public removeListener(event: string, listener: (...args: unknown[]) => void): void {
        this.internalEmitter.removeListener(event, listener);
    }

    public emit(event: string, ...args: unknown[]): boolean {
        return this.internalEmitter.emit(event, ...args);
    }

    public listenerCount(event: string): number {
        return this.internalEmitter.listenerCount(event);
    }

    public removeAllListeners(event?: string): void {
        // Node's EventEmitter distinguishes removeAllListeners() (removes all
        // events) from removeAllListeners(undefined) (no-op for that key). Pass
        // the no-arg form through explicitly so clearing all events works.
        if (event === undefined) {
            this.internalEmitter.removeAllListeners();
        } else {
            this.internalEmitter.removeAllListeners(event);
        }
    }

    public constructor(tls: TlsConnection) {
        this.id = createId("tls") as TransportId;
        this.tls = tls;
        // Forward close/error from the TLS connection onto the adapter's
        // PRIVATE emitter — never the shared injected bus.
        this.tls.on("close", () => {
            this.internalEmitter.emit("close", false);
        });
        this.tls.on("error", (err: unknown) => {
            this.internalEmitter.emit("error", err);
        });
    }

    /** Current lifecycle, projected from the underlying TLS state. */
    public get state(): TransportState {
        return tlsToTransportState(this.tls.state);
    }

    /** Encrypt and write application data through the TLS connection. */
    public write(data: Uint8Array): Promise<void> {
        return this.tls.write(data);
    }

    /** Read the next decrypted record and return its payload bytes. */
    public async read(): Promise<Uint8Array> {
        const result = await this.tls.read();
        return result.payload;
    }

    /** Send close_notify and close the underlying TLS transport. */
    public close(reason?: CloseReason): Promise<void> {
        void reason;
        return this.tls.close();
    }
}

/**
 * Build a {@link Transport} backed by an established {@link TlsConnection}.
 *
 * The adapter owns a private event bus, so no {@link EventProvider} is needed
 * here — close/error forwarded from the TLS connection are delivered to HTTP
 * listeners without ever touching the shared injected bus.
 */
export function adaptTlsToTransport(tls: TlsConnection): Transport {
    return new TlsTransportAdapter(tls);
}

/** Project a {@link TlsState} onto a {@link TransportState} (exhaustive). */
function tlsToTransportState(s: TlsState): TransportState {
    switch (s.state) {
        case "connecting":
        case "handshaking":
            return { state: "connecting" };
        case "open":
            return { state: "open" };
        case "closed":
            return { state: "closed", reason: tlsCloseReasonToTransport(s.reason) };
        default:
            return assertNever(s);
    }
}

/** Map a TLS {@link TlsCloseReasonType} onto a transport {@link CloseReason}. */
function tlsCloseReasonToTransport(reason: TlsCloseReasonType): CloseReason {
    switch (reason.kind) {
        case "close_notify":
            return { kind: "client_close" };
        case "transport_closed":
            return { kind: "remote_close" };
        case "timeout":
            return { kind: "timeout", afterMs: reason.afterMs };
        case "error":
            return { kind: "error", error: reason.error };
        default:
            return assertNever(reason);
    }
}
