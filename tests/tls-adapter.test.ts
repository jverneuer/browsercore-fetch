import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type {
    CipherSuite,
    CloseReason,
    ProtocolVersion,
    TlsConnection,
    TlsSessionId,
    TlsState,
} from "@browsercore/tls";
import { TlsError } from "@browsercore/tls";
import { adaptTlsToTransport, TlsTransportAdapter } from "../src/tls-adapter.js";

/**
 * A controllable fake {@link TlsConnection}. Tests set `.state`, queue reads,
 * record writes, and can emit close/error events to exercise the adapter's
 * event forwarding.
 */
class FakeTls extends EventEmitter implements TlsConnection {
    public readonly id: TlsSessionId = "tls-fake" as TlsSessionId;
    public readonly protocolVersion: ProtocolVersion = { name: "TLS 1.3", wire: 0x0304 };
    public readonly cipherSuite: CipherSuite = "TLS_AES_128_GCM_SHA256";
    public alpnProtocol: string | undefined = "h2";
    public state: TlsState = {
        state: "open",
        sessionId: this.id,
        protocolVersion: this.protocolVersion,
        cipherSuite: this.cipherSuite,
        alpnProtocol: "h2",
    };
    public readonly writes: Uint8Array[] = [];
    public readonly closes: Array<CloseReason | undefined> = [];
    private readonly reads: Array<{ payload: Uint8Array }> = [];

    public write(data: Uint8Array): Promise<void> {
        this.writes.push(data);
        return Promise.resolve();
    }
    public async read(): Promise<{ payload: Uint8Array }> {
        const next = this.reads.shift();
        if (next === undefined) {
            // Block forever until the test unblocks; not needed for these tests.
            return new Promise(() => {});
        }
        return next;
    }
    public close(reason?: CloseReason): Promise<void> {
        this.closes.push(reason);
        return Promise.resolve();
    }

    /** Push a fake decrypted record for the adapter to read. */
    public pushRead(payload: Uint8Array): void {
        this.reads.push({ payload });
    }
    public setState(s: TlsState): void {
        this.state = s;
    }
}

describe("TlsTransportAdapter — id", () => {
    it("generates its own tls_-prefixed TransportId independent of the TLS session", () => {
        const tls = new FakeTls();
        const adapter = new TlsTransportAdapter(tls);
        expect(adapter.id.startsWith("tls_")).toBe(true);
        // Independent of the underlying TLS session id.
        expect(adapter.id).not.toBe(tls.id);
    });
});

describe("TlsTransportAdapter — state projection", () => {
    it("projects connecting -> connecting", () => {
        const tls = new FakeTls();
        tls.setState({ state: "connecting" });
        expect(new TlsTransportAdapter(tls).state).toEqual({ state: "connecting" });
    });

    it("projects handshaking -> connecting", () => {
        const tls = new FakeTls();
        tls.setState({ state: "handshaking" });
        expect(new TlsTransportAdapter(tls).state).toEqual({ state: "connecting" });
    });

    it("projects open -> open", () => {
        const tls = new FakeTls();
        expect(new TlsTransportAdapter(tls).state.state).toBe("open");
    });

    it("projects closed + close_notify -> client_close", () => {
        const tls = new FakeTls();
        tls.setState({ state: "closed", reason: { kind: "close_notify" } });
        const st = new TlsTransportAdapter(tls).state;
        expect(st).toEqual({ state: "closed", reason: { kind: "client_close" } });
    });

    it("projects closed + transport_closed -> remote_close", () => {
        const tls = new FakeTls();
        tls.setState({ state: "closed", reason: { kind: "transport_closed" } });
        const st = new TlsTransportAdapter(tls).state;
        expect(st.state).toBe("closed");
        if (st.state === "closed") expect(st.reason.kind).toBe("remote_close");
    });

    it("projects closed + timeout -> timeout with afterMs", () => {
        const tls = new FakeTls();
        tls.setState({ state: "closed", reason: { kind: "timeout", afterMs: 7500 } });
        const st = new TlsTransportAdapter(tls).state;
        if (st.state === "closed") {
            expect(st.reason).toEqual({ kind: "timeout", afterMs: 7500 });
        }
    });

    it("projects closed + error -> error with the underlying error", () => {
        const tls = new FakeTls();
        const err = new TlsError("bad");
        tls.setState({ state: "closed", reason: { kind: "error", error: err } });
        const st = new TlsTransportAdapter(tls).state;
        if (st.state === "closed") {
            expect(st.reason.kind).toBe("error");
            if (st.reason.kind === "error") expect(st.reason.error).toBe(err);
        }
    });
});

describe("TlsTransportAdapter — IO forwarding", () => {
    it("write() forwards bytes to the underlying TLS connection", async () => {
        const tls = new FakeTls();
        const adapter = new TlsTransportAdapter(tls);
        const data = new TextEncoder().encode("hello");
        await adapter.write(data);
        expect(tls.writes).toEqual([data]);
    });

    it("read() returns only the payload of the decrypted record", async () => {
        const tls = new FakeTls();
        const payload = new TextEncoder().encode("decrypted");
        tls.pushRead(payload);
        const adapter = new TlsTransportAdapter(tls);
        const out = await adapter.read();
        expect(out).toEqual(payload);
    });

    it("close() forwards to tls.close() and ignores the reason arg", async () => {
        const tls = new FakeTls();
        const adapter = new TlsTransportAdapter(tls);
        // Pass a reason — the adapter must not forward it (TLS close_notify is
        // its own concern); the call simply resolves.
        await adapter.close({ kind: "client_close" });
        expect(tls.closes).toHaveLength(1);
        expect(tls.closes[0]).toBeUndefined();
    });
});

describe("TlsTransportAdapter — event forwarding", () => {
    it("forwards the TLS 'close' event as an adapter 'close' event with false", async () => {
        const tls = new FakeTls();
        const adapter = new TlsTransportAdapter(tls);
        let fired = false;
        adapter.on("close", (val) => {
            fired = true;
            expect(val).toBe(false);
        });
        tls.emit("close");
        expect(fired).toBe(true);
    });

    it("forwards the TLS 'error' event as an adapter 'error' event", () => {
        const tls = new FakeTls();
        const adapter = new TlsTransportAdapter(tls);
        let seen: unknown;
        adapter.on("error", (err) => {
            seen = err;
        });
        const err = new Error("boom");
        tls.emit("error", err);
        expect(seen).toBe(err);
    });
});

// ---------------------------------------------------------------------------
// EventProvider surface — the adapter satisfies Transport's event surface via
// a PRIVATE EventEmitter (not the shared injected bus). These tests exercise
// every delegation method against that private emitter to lock in behavior and
// keep coverage on the thin delegation layer.
// ---------------------------------------------------------------------------
describe("TlsTransportAdapter — EventProvider surface (private emitter)", () => {
    it("emit() delivers to on() listeners on the private bus", () => {
        const adapter = new TlsTransportAdapter(new FakeTls());
        let seen: unknown;
        adapter.on("data", (val) => { seen = val; });
        adapter.emit("data", 42);
        expect(seen).toBe(42);
    });

    it("once() fires a listener exactly once on the private bus", () => {
        const adapter = new TlsTransportAdapter(new FakeTls());
        let count = 0;
        adapter.once("tick", () => { count++; });
        adapter.emit("tick");
        adapter.emit("tick");
        expect(count).toBe(1);
    });

    it("off() removes a listener registered via on()", () => {
        const adapter = new TlsTransportAdapter(new FakeTls());
        let count = 0;
        const cb = (): void => { count++; };
        adapter.on("x", cb);
        adapter.emit("x");
        adapter.off("x", cb);
        adapter.emit("x");
        expect(count).toBe(1);
    });

    it("removeListener() is an alias that removes a listener", () => {
        const adapter = new TlsTransportAdapter(new FakeTls());
        let count = 0;
        const cb = (): void => { count++; };
        adapter.on("y", cb);
        adapter.removeListener("y", cb);
        adapter.emit("y");
        expect(count).toBe(0);
    });

    it("listenerCount() reflects registered listeners", () => {
        const adapter = new TlsTransportAdapter(new FakeTls());
        expect(adapter.listenerCount("z")).toBe(0);
        const cb = (): void => {};
        adapter.on("z", cb);
        expect(adapter.listenerCount("z")).toBe(1);
    });

    it("removeAllListeners() clears listeners for an event", () => {
        const adapter = new TlsTransportAdapter(new FakeTls());
        let count = 0;
        adapter.on("w", () => { count++; });
        adapter.on("w", () => { count++; });
        adapter.removeAllListeners("w");
        adapter.emit("w");
        expect(count).toBe(0);
    });

    it("removeAllListeners() with no arg clears all events", () => {
        const adapter = new TlsTransportAdapter(new FakeTls());
        adapter.on("a", () => {});
        adapter.on("b", () => {});
        adapter.removeAllListeners();
        expect(adapter.listenerCount("a")).toBe(0);
        expect(adapter.listenerCount("b")).toBe(0);
    });
});

describe("adaptTlsToTransport", () => {
    it("returns a TlsTransportAdapter wrapping the connection", () => {
        const tls = new FakeTls();
        const transport = adaptTlsToTransport(tls);
        expect(transport).toBeInstanceOf(TlsTransportAdapter);
        expect(transport.state.state).toBe("open");
    });
});

// ---------------------------------------------------------------------------
// Exhaustiveness-check tests for the two `assertNever` default branches in
// tlsToTransportState (line 82) and tlsCloseReasonToTransport (line 98).
// These branches are unreachable in normal operation — they fire only if a
// new TlsState or TlsCloseReasonType variant is added without a matching
// case. We force them by feeding a forged state/reason through the same
// code path the adapter uses, so the default branch is covered.
// ---------------------------------------------------------------------------

describe("tlsToTransportState — exhaustiveness default branch", () => {
    it("throws via assertNever for an unhandled TlsState variant", () => {
        // The adapter reads `this.tls.state` through tlsToTransportState.
        // We set a forged state whose `state` discriminant is not one of
        // connecting/handshaking/open/closed, forcing the default branch.
        const tls = new FakeTls();
        tls.setState({ state: "surprise" } as never);
        const adapter = new TlsTransportAdapter(tls);
        expect(() => adapter.state).toThrowError(/Unexpected value/);
    });
});

describe("tlsCloseReasonToTransport — exhaustiveness default branch", () => {
    it("throws via assertNever for an unhandled TlsCloseReasonType variant", () => {
        // A closed state with a forged reason.kind forces the default branch
        // of tlsCloseReasonToTransport.
        const tls = new FakeTls();
        tls.setState({ state: "closed", reason: { kind: "surprise" } } as never);
        const adapter = new TlsTransportAdapter(tls);
        expect(() => adapter.state).toThrowError(/Unexpected value/);
    });
});
