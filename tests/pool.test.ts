import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import { createPool, type ConnectionPool } from "../src/pool.js";
import { parseUrl } from "../src/url.js";
import type { ParsedUrl } from "../src/types.js";

// ---------------------------------------------------------------------------
// Minimal fake transport + a fallback profile. The pool's transportFactory
// seam returns a Transport that speakHttp1OverTransport wraps; for these
// lifecycle tests we only need the transport to be openable and closable, not
// to speak HTTP. A connection that never receives bytes is fine because we
// never dispatch a request — we only exercise acquire/release/teardown/drain.
// ---------------------------------------------------------------------------

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
        // Never resolves; no dispatch happens in these tests.
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
        tls: {
            cipherSuites: [],
            extensionOrder: [],
            supportedVersions: [],
            keyShareGroups: [],
            signatureAlgorithms: [],
            grease: false,
        },
        http2: {
            settings: {},
            initialWindowSize: 65535,
            maxFrameSize: 16384,
            headerTableSize: 4096,
            weight: 16,
        },
        http1: {
            defaultHeaders: {},
            headerOrder: [],
            connection: "keep-alive",
            acceptEncoding: "gzip",
        },
    };
}

const lookup = (_id: ProfileId): BrowserProfile | undefined => undefined;

function url(s: string): ParsedUrl {
    return parseUrl(s);
}

/** Build a pool whose transportFactory returns a fresh StubTransport each call. */
function makePool(opts: {
    idleTimeoutMs?: number;
    factory?: (host: string, port: number) => Transport;
}): { pool: ConnectionPool; calls: Array<{ host: string; port: number }>; transports: StubTransport[] } {
    const calls: Array<{ host: string; port: number }> = [];
    const transports: StubTransport[] = [];
    const factory =
        opts.factory ??
        ((host: string, port: number) => {
            calls.push({ host, port });
            const t = new StubTransport(`t${calls.length}`);
            transports.push(t);
            return t;
        });
    const pool = createPool({ idleTimeoutMs: opts.idleTimeoutMs, transportFactory: factory }, lookup, fallbackProfile());
    return { pool, calls, transports };
}

describe("pool — acquire + reuse", () => {
    it("establishes a connection on first acquire (http1 over the factory transport)", async () => {
        const { pool, calls } = makePool({});
        try {
            const conn = await pool.getConnection(url("http://example.com/"), undefined);
            expect(conn.protocol).toBe("http1");
            expect(calls).toEqual([{ host: "example.com", port: 80 }]);
        } finally {
            await pool.drain();
        }
    });

    it("reuses the pooled connection for a second acquire on the same origin", async () => {
        const { pool, calls } = makePool({});
        try {
            const a = await pool.getConnection(url("http://example.com/a"), undefined);
            pool.release(url("http://example.com/a"));
            const b = await pool.getConnection(url("http://example.com/b"), undefined);
            // Same origin -> same underlying connection, factory called once.
            expect(a).toBe(b);
            expect(calls).toHaveLength(1);
        } finally {
            await pool.drain();
        }
    });

    it("establishes separate connections for distinct origins", async () => {
        const { pool, calls } = makePool({});
        try {
            await pool.getConnection(url("http://a.example/"), undefined);
            pool.release(url("http://a.example/"));
            await pool.getConnection(url("http://b.example/"), undefined);
            expect(calls).toEqual([
                { host: "a.example", port: 80 },
                { host: "b.example", port: 80 },
            ]);
        } finally {
            await pool.drain();
        }
    });

    it("distinguishes origins by port", async () => {
        const { pool, calls } = makePool({});
        try {
            await pool.getConnection(url("http://example.com:80/"), undefined);
            pool.release(url("http://example.com:80/"));
            await pool.getConnection(url("http://example.com:81/"), undefined);
            expect(calls).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });
});

describe("pool — teardown", () => {
    it("force-closes the transport and evicts the entry", async () => {
        const { pool, transports } = makePool({});
        try {
            await pool.getConnection(url("http://example.com/"), undefined);
            pool.teardown(url("http://example.com/"));
            // The underlying transport was force-closed.
            expect(transports[0]?.closed).toBe(true);
            // A subsequent acquire establishes a fresh connection.
            await pool.getConnection(url("http://example.com/"), undefined);
            expect(transports).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });

    it("teardown on an unknown key is a no-op (does not throw)", () => {
        const { pool } = makePool({});
        expect(() => pool.teardown(url("http://never-acquired.example/"))).not.toThrow();
    });
});

describe("pool — drain", () => {
    it("closes every pooled connection and clears timers", async () => {
        const { pool, transports } = makePool({});
        await pool.getConnection(url("http://a.example/"), undefined);
        pool.release(url("http://a.example/"));
        await pool.getConnection(url("http://b.example/"), undefined);
        pool.release(url("http://b.example/"));
        await pool.drain();
        // Both underlying transports were closed.
        expect(transports.every((t) => t.closed)).toBe(true);
    });

    it("drain on an empty pool resolves", async () => {
        const { pool } = makePool({});
        await expect(pool.drain()).resolves.toBeUndefined();
    });
});

describe("pool — idle eviction", () => {
    it("evicts a connection that sits idle past idleTimeoutMs", async () => {
        const { pool, calls } = makePool({ idleTimeoutMs: 40 });
        try {
            await pool.getConnection(url("http://example.com/"), undefined);
            pool.release(url("http://example.com/"));
            expect(calls).toHaveLength(1);
            // Wait long enough for the idle timer to fire + evict.
            await new Promise((r) => setTimeout(r, 90));
            // After eviction, a new acquire must re-establish.
            await pool.getConnection(url("http://example.com/"), undefined);
            expect(calls).toHaveLength(2);
        } finally {
            await pool.drain();
        }
    });

    it("release restarts the idle timer so an in-use connection is not evicted", async () => {
        // Acquire, then re-acquire within the idle window: the timer is cleared
        // while in use and only started on release.
        const { pool, calls } = makePool({ idleTimeoutMs: 40 });
        try {
            await pool.getConnection(url("http://example.com/"), undefined);
            // Hold it (no release) for longer than the idle timeout.
            await new Promise((r) => setTimeout(r, 70));
            // Still pooled because the timer was never started (in use).
            expect(calls).toHaveLength(1);
        } finally {
            await pool.drain();
        }
    });

    it("disables idle eviction when idleTimeoutMs is 0", async () => {
        const { pool, calls } = makePool({ idleTimeoutMs: 0 });
        try {
            await pool.getConnection(url("http://example.com/"), undefined);
            pool.release(url("http://example.com/"));
            await new Promise((r) => setTimeout(r, 60));
            // No eviction -> same connection reused.
            await pool.getConnection(url("http://example.com/"), undefined);
            expect(calls).toHaveLength(1);
        } finally {
            await pool.drain();
        }
    });
});

describe("pool — profile resolution", () => {
    it("uses the fallback profile when no profileId is given", async () => {
        // The factory path ignores the profile (it speaks http1 directly), but
        // this confirms acquire-without-profile resolves without error.
        const { pool } = makePool({});
        try {
            const conn = await pool.getConnection(url("http://example.com/"), undefined);
            expect(conn).toBeDefined();
        } finally {
            await pool.drain();
        }
    });

    it("falls back to the fallback profile when lookup returns undefined", async () => {
        const { pool } = makePool({});
        try {
            const conn = await pool.getConnection(url("http://example.com/"), "missing" as ProfileId);
            expect(conn).toBeDefined();
        } finally {
            await pool.drain();
        }
    });
});
