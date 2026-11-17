/**
 * One-shot fetch() vs createClient() wire-parity tests (#79).
 *
 * The top-level one-shot fetch() was reported GOAWAY'd by real h2 servers
 * (example.com) while the createClient path worked. The differential trace
 * (fake TLS boundary + in-process h2 peer capturing every client byte) found
 * the divergence: for IDENTICAL options the two entry points already emit the
 * same bytes — the GOAWAY came from the profile-less wiring BOTH paths share.
 * The fallback profile carries no http2.connectionWindowUpdate, and
 * profileHttp2Config coerced absent → 0, so the http2 layer emitted a
 * connection-level WINDOW_UPDATE with increment 0 — RFC 9113 §6.9 makes that
 * a connection error of type PROTOCOL_ERROR, and real peers answer with
 * GOAWAY. Chrome-profiled requests carry 15663105, which is why only the
 * profile-less one-shot path died in the field.
 *
 * These tests pin both halves of the fix:
 *   1. Differential: one-shot fetch() and createClient().fetch() produce a
 *      byte-identical SETTINGS/HEADERS prelude against a capture sink, for
 *      identical options — with and without a profile.
 *   2. Wire validity: the profile-less prelude contains NO zero-increment
 *      connection WINDOW_UPDATE (pre-fix it does), while a real profile's
 *      increment still reaches the wire.
 *
 * The TLS boundary is mocked (connectTls → FakeTlsConnection with alpn "h2")
 * and the TCP dial is mocked (connect → in-memory H2FakeTransport pair), but
 * the REAL pool → establishConnection → connectHttp2 stack runs, so the
 * captured bytes are exactly what a peer would observe on the wire.
 */

import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@browsercore/transport";
import type { TlsConnection } from "@browsercore/tls";

// ---------------------------------------------------------------------------
// Module seams: intercept the two runtime boundaries below the pool so the
// real dial path runs against in-memory capture sinks.
// ---------------------------------------------------------------------------

const seams = vi.hoisted(() => ({
    /** Set per run: hands the dialed transport to the fake h2 backend. */
    connectImpl: undefined as undefined | ((opts: unknown) => Promise<Transport>),
    /** Set per run: wraps the dialed transport in a fake h2-negotiated TLS conn. */
    connectTlsImpl: undefined as undefined | ((opts: unknown) => Promise<TlsConnection>),
}));

vi.mock("@browsercore/transport", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/transport")>();
    return {
        ...actual,
        connect: (opts: unknown): Promise<Transport> => {
            if (seams.connectImpl === undefined) {
                throw new Error("transport connect seam not installed for this test");
            }
            return seams.connectImpl(opts);
        },
    };
});

vi.mock("@browsercore/tls", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/tls")>();
    return {
        ...actual,
        connectTls: (opts: unknown): Promise<TlsConnection> => {
            if (seams.connectTlsImpl === undefined) {
                throw new Error("tls connectTls seam not installed for this test");
            }
            return seams.connectTlsImpl(opts);
        },
    };
});

// Import AFTER the mocks are registered.
// eslint-disable-next-line import/first
import { createClient, fetch as fetchOneShot } from "../src/index.js";
// eslint-disable-next-line import/first
import { FakeHttp2Server, FakeTlsConnection, H2FakeTransport } from "./h2-server.js";
// eslint-disable-next-line import/first
import { createTestPlatform } from "./helpers/test-platform.js";

/** A wire capture: every byte the client sent, plus the response outcome. */
interface WireCapture {
    readonly bytes: () => Uint8Array;
    readonly clientTransport: H2FakeTransport;
}

/**
 * Install the capture sinks for one run: a fresh paired transport per dial,
 * the server side running the scripted in-process h2 peer, and a byte tap on
 * the server side that accumulates everything the client sends.
 */
function installCaptureBackend(): WireCapture {
    const { client, server } = H2FakeTransport.pair();
    const chunks: Uint8Array[] = [];
    server.on("data", (chunk: Uint8Array) => {
        chunks.push(chunk);
    });
    new FakeHttp2Server(server, () => ({ status: 200, body: "ok" }));
    seams.connectImpl = async () => client;
    seams.connectTlsImpl = async (opts: unknown) =>
        new FakeTlsConnection((opts as { transport: H2FakeTransport }).transport, "h2");
    return {
        clientTransport: client,
        bytes: (): Uint8Array => {
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const out = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
            return out;
        },
    };
}

/** One decoded client frame (subset this suite reasons over). */
interface WireFrame {
    readonly type: number;
    readonly streamId: number;
    readonly payload: Uint8Array;
}

/** Split captured client bytes into frames (skipping the 24-byte preface). */
function decodeFrames(bytes: Uint8Array): WireFrame[] {
    const frames: WireFrame[] = [];
    let offset = 24;
    while (offset + 9 <= bytes.length) {
        const length = (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
        const type = bytes[offset + 3]!;
        const streamId =
            ((bytes[offset + 5]! << 24) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 8) | bytes[offset + 8]!) >>> 0;
        if (offset + 9 + length > bytes.length) {
            // Trailing partial frame (capture raced the writer) — ignore.
            break;
        }
        frames.push({ type, streamId, payload: bytes.slice(offset + 9, offset + 9 + length) });
        offset += 9 + length;
    }
    return frames;
}

/**
 * The SETTINGS/HEADERS prelude: every client byte up to and including the
 * first HEADERS frame (the request). Everything after differs by design
 * between the two entry points (the one-shot closes its client once the
 * response resolves, emitting a graceful GOAWAY the retained client has not
 * sent yet at capture time).
 */
function preludeThroughRequestHeaders(bytes: Uint8Array): Uint8Array {
    const frames = decodeFrames(bytes);
    let end = bytes.length;
    let offset = 24;
    for (const frame of frames) {
        offset += 9 + frame.payload.length;
        if (frame.type === 0x1) {
            end = offset;
            break;
        }
    }
    return bytes.slice(0, end);
}

/** Every connection-level WINDOW_UPDATE increment the client sent. */
function connectionWindowUpdates(bytes: Uint8Array): number[] {
    return decodeFrames(bytes)
        .filter((frame) => frame.type === 0x8 && frame.streamId === 0)
        .map((frame) =>
            ((frame.payload[0]! << 24) | (frame.payload[1]! << 16) | (frame.payload[2]! << 8) | frame.payload[3]!) >>> 0,
        );
}

/** Run the one-shot top-level fetch() against the capture backend. */
async function runOneShot(url: string, options: Record<string, unknown> | undefined): Promise<WireCapture> {
    const capture = installCaptureBackend();
    const response = await fetchOneShot(url, options as never, createTestPlatform());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    return capture;
}

/** Run the createClient().fetch() path against the capture backend. */
async function runClient(url: string, clientOptions: Record<string, unknown>): Promise<WireCapture> {
    const capture = installCaptureBackend();
    const client = createClient({ ...clientOptions, platform: createTestPlatform() } as never);
    try {
        const response = await client.fetch(url);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("ok");
    } finally {
        await client.close();
    }
    return capture;
}

describe("one-shot fetch() vs createClient() — h2 wire parity (#79)", () => {
    it("emits a byte-identical SETTINGS/HEADERS prelude with NO profile", async () => {
        // The exact shape from the #79 report: fetch(url, {}, platform) vs
        // createClient({ platform }).fetch(url).
        const oneShot = await runOneShot("https://example.com/", {});
        const clientPath = await runClient("https://example.com/", {});
        expect(Array.from(preludeThroughRequestHeaders(oneShot.bytes()))).toEqual(
            Array.from(preludeThroughRequestHeaders(clientPath.bytes())),
        );
    });

    it("emits a byte-identical SETTINGS/HEADERS prelude with a browser profile", async () => {
        const oneShot = await runOneShot("https://example.com/", { profile: "chrome-140" });
        const clientPath = await runClient("https://example.com/", { profile: "chrome-140" });
        expect(Array.from(preludeThroughRequestHeaders(oneShot.bytes()))).toEqual(
            Array.from(preludeThroughRequestHeaders(clientPath.bytes())),
        );
    });
});

describe("h2 prelude wire validity — profile-less fallback (#79)", () => {
    it("never emits a zero-increment connection WINDOW_UPDATE (the GOAWAY trigger)", async () => {
        // Pre-fix, the profile-less dial emitted WINDOW_UPDATE stream=0
        // increment=0 (RFC 9113 §6.9 connection error → server GOAWAY). With
        // the fix, a profile without connectionWindowUpdate sends NO frame.
        const oneShot = await runOneShot("https://example.com/", {});
        const clientPath = await runClient("https://example.com/", {});
        expect(connectionWindowUpdates(oneShot.bytes()).filter((increment) => increment === 0)).toEqual([]);
        expect(connectionWindowUpdates(clientPath.bytes()).filter((increment) => increment === 0)).toEqual([]);
    });

    it("still carries a real profile's connection window increment on the wire", async () => {
        // chrome-140 advertises 15663105 (Chrome's early large connection
        // window); the fix must not silence real increments.
        const oneShot = await runOneShot("https://example.com/", { profile: "chrome-140" });
        expect(connectionWindowUpdates(oneShot.bytes())).toContain(15663105);
    });
});
