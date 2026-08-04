/**
 * Tests for the http2 close path in pool.ts (closePooled, lines 70-73).
 *
 * The existing pool.test.ts only exercises http1 pooled connections (via the
 * transportFactory seam). This file mocks the dispatch module so the pool
 * establishes an http2 connection, then verifies drain() closes it through
 * the http2 branch of closePooled.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";

// ---------------------------------------------------------------------------
// Top-level mock for the dispatch module's establishHttp1OverTransport so the
// pool establishes an http2 pooled connection instead of http1.
// ---------------------------------------------------------------------------

const mockEstablishHttp1 = vi.fn();

vi.mock("../src/dispatch.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/dispatch.js")>();
    return {
        ...actual,
        establishHttp1OverTransport: (opts: unknown) => mockEstablishHttp1(opts),
    };
});

// Import AFTER the mock is registered.
// eslint-disable-next-line import/first
import { createPool } from "../src/pool.js";
// eslint-disable-next-line import/first
import { parseUrl } from "../src/url.js";
import type { ParsedUrl } from "../src/types.js";

class StubTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    public closed = false;
    constructor(id = "t") {
        super();
        this.id = id as TransportId;
    }
    public get state(): TransportState {
        return this.closed ? { state: "closed", reason: { kind: "client_close" } } : { state: "open" };
    }
    public write(): Promise<void> {
        return Promise.resolve();
    }
    public read(): Promise<Uint8Array> {
        return new Promise(() => {});
    }
    public close(): Promise<void> {
        this.closed = true;
        this.emit("close", false);
        return Promise.resolve();
    }
}

function fallbackProfile(): BrowserProfile {
    return {
        id: "default" as ProfileId,
        name: "default",
        version: "0.0.0",
        tls: { cipherSuites: [], extensionOrder: [], supportedVersions: [], keyShareGroups: [], signatureAlgorithms: [], grease: false },
        http2: { settings: {}, initialWindowSize: 65535, maxFrameSize: 16384, headerTableSize: 4096, weight: 16 },
        http1: { defaultHeaders: {}, headerOrder: [], connection: "keep-alive", acceptEncoding: "gzip" },
    };
}

const lookup = (_id: ProfileId): BrowserProfile | undefined => undefined;

function url(s: string): ParsedUrl {
    return parseUrl(s);
}

describe("pool — http2 close path", () => {
    it("closes an http2 pooled connection through the http2 branch on drain", async () => {
        const h2Closed = vi.fn();
        mockEstablishHttp1.mockReset();
        mockEstablishHttp1.mockResolvedValue({
            protocol: "http2",
            id: "h2-pool-test",
            conn: { id: "h2-pool-test", close: h2Closed },
        });

        const factory = (): Transport => new StubTransport("h2-factory");
        const pool = createPool({ transportFactory: factory }, lookup, fallbackProfile());
        try {
            const conn = await pool.getConnection(url("http://example.com/"), undefined);
            expect(conn.protocol).toBe("http2");
            await pool.drain();
            // The http2 branch of closePooled called conn.close() (no args).
            expect(h2Closed).toHaveBeenCalledTimes(1);
        } finally {
            mockEstablishHttp1.mockReset();
        }
    });
});
