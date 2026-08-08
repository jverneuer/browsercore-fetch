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
 */

import type { EventProvider } from "@browsercore/contracts";
import type { CloseReason as TlsCloseReasonType, TlsConnection, TlsState } from "@browsercore/tls";
import type { CloseReason, Transport, TransportId, TransportState } from "@browsercore/transport";
import { assertNever, createId } from "./utils.js";

/**
 * Adapt a {@link TlsConnection} to the {@link Transport} interface the HTTP
 * layers expect. The adapter owns its own {@link TransportId} (independent of
 * the TLS session id) and projects the TLS lifecycle onto transport states.
 */
export class TlsTransportAdapter implements Transport {
    public readonly id: TransportId;
    private readonly events: EventProvider;
    private readonly tls: TlsConnection;

    // -------------------------------------------------------------------------
    // EventProvider delegation — decouples the adapter from node:events.
    // -------------------------------------------------------------------------

    public on(event: string, listener: (...args: unknown[]) => void): void {
        this.events.on(event, listener);
    }

    public once(event: string, listener: (...args: unknown[]) => void): void {
        this.events.once(event, listener);
    }

    public off(event: string, listener: (...args: unknown[]) => void): void {
        this.events.off(event, listener);
    }

    public removeListener(event: string, listener: (...args: unknown[]) => void): void {
        this.events.removeListener(event, listener);
    }

    public emit(event: string, ...args: unknown[]): boolean {
        return this.events.emit(event, ...args);
    }

    public listenerCount(event: string): number {
        return this.events.listenerCount(event);
    }

    public removeAllListeners(event?: string): void {
        this.events.removeAllListeners(event);
    }

    public constructor(tls: TlsConnection, events: EventProvider) {
        this.id = createId("tls") as TransportId;
        this.events = events;
        this.tls = tls;
        // Forward close/error from the TLS connection to adapter listeners.
        this.tls.on("close", () => {
            this.emit("close", false);
        });
        this.tls.on("error", (err: unknown) => {
            this.emit("error", err);
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

/** Build a {@link Transport} backed by an established {@link TlsConnection}. */
export function adaptTlsToTransport(tls: TlsConnection, events: EventProvider): Transport {
    return new TlsTransportAdapter(tls, events);
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
