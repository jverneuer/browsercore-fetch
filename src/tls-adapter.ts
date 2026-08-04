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

import { EventEmitter } from "node:events";
import type { CloseReason as TlsCloseReasonType, TlsConnection, TlsState } from "@browsercore/tls";
import type { CloseReason, Transport, TransportId, TransportState } from "@browsercore/transport";
import { assertNever, createId } from "./utils.js";

/**
 * Adapt a {@link TlsConnection} to the {@link Transport} interface the HTTP
 * layers expect. The adapter owns its own {@link TransportId} (independent of
 * the TLS session id) and projects the TLS lifecycle onto transport states.
 */
// The `Transport` interface itself extends `EventEmitter`, so any Transport
// implementation must extend it too — `EventTarget` cannot satisfy the contract.
// eslint-disable-next-line unicorn/prefer-event-target
export class TlsTransportAdapter extends EventEmitter implements Transport {
    public readonly id: TransportId;
    private readonly tls: TlsConnection;

    public constructor(tls: TlsConnection) {
        super();
        this.id = createId("tls") as TransportId;
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
