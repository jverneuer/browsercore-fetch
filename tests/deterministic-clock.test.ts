import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import {
    createClient,
    FetchTimeoutError,
    systemClock,
    type Clock,
    type TimerHandle,
} from "../src/index.js";
import { createPool, type ConnectionPool } from "../src/pool.js";
import { parseUrl } from "../src/url.js";
import { stubEvents } from "./helpers/test-platform.js";

/**
 * Deterministic-clock tests — the injected-Clock seam (audit #6).
 *
 * fetch resolves `clock = options.clock ?? platform.time ?? systemClock` and
 * routes EVERY timer it arms through that Clock: the whole-request timeout
 * (client.ts) and the pool's idle-eviction timers (pool.ts). These tests
 * inject a ManualClock — virtual time, zero real timers — and assert the
 * timeouts fire at EXACT virtual instants: not one virtual ms early, not one
 * late. If any code path regressed to a bare `setTimeout`, the
 * advance(N-1)-still-pending assertions would fail (a real timer cannot be
 * held at N-1) or the promise would settle on wall time, not virtual time.
 */

/** A scheduled virtual timer. The object itself is the opaque TimerHandle. */
interface VirtualTimer {
    readonly dueMs: number;
    readonly sequence: number;
    fire(): void;
}

/**
 * Manual-advance {@link Clock}: `advance()` moves monotonic (and wall) time
 * and synchronously fires every timer whose deadline has passed, in due order.
 * (Same harness @browsercore/transport's deterministic-clock suite uses.)
 */
class ManualClock implements Clock {
    private wallMs: number;
    private monoMs = 0;
    private nextSequence = 0;
    private readonly pendingTimers = new Set<VirtualTimer>();
    /** Milliseconds of every `setTimeout` call, in order — for budget assertions. */
    public readonly arms: number[] = [];

    constructor(wallMs = 1_700_000_000_000) {
        this.wallMs = wallMs;
    }

    public now(): number {
        return this.wallMs;
    }

    public monotonic(): number {
        return this.monoMs;
    }

    public sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            this.setTimeout(ms, resolve);
        });
    }

    public setTimeout(ms: number, fn: () => void): TimerHandle {
        const timer: VirtualTimer = {
            dueMs: this.monoMs + ms,
            sequence: this.nextSequence++,
            fire: fn,
        };
        this.pendingTimers.add(timer);
        this.arms.push(ms);
        return timer;
    }

    public clearTimeout(handle: TimerHandle): void {
        this.pendingTimers.delete(handle as VirtualTimer);
    }

    /** Advance monotonic + wall time, firing due timers in due-then-FIFO order. */
    public advance(deltaMs: number): void {
        const targetMs = this.monoMs + deltaMs;
        for (;;) {
            let next: VirtualTimer | undefined;
            for (const timer of this.pendingTimers) {
                if (timer.dueMs > targetMs) {
                    continue;
                }
                if (
                    next === undefined ||
                    timer.dueMs < next.dueMs ||
                    (timer.dueMs === next.dueMs && timer.sequence < next.sequence)
                ) {
                    next = timer;
                }
            }
            if (next === undefined) {
                break;
            }
            this.pendingTimers.delete(next);
            // A callback firing at its due instant must observe the clock AT
            // that instant (deadline math re-reads monotonic() in callbacks).
            this.monoMs = Math.max(this.monoMs, next.dueMs);
            next.fire();
        }
        this.monoMs = targetMs;
        this.wallMs += deltaMs;
    }

    public get pendingCount(): number {
        return this.pendingTimers.size;
    }
}

/** Drain microtasks + the close/teardown cascade so settlements propagate. */
async function drain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Outcome box for a promise under virtual time — inspect without awaiting. */
interface Attempt {
    error: Error | undefined;
    done: boolean;
}

function track(promise: Promise<unknown>): Attempt {
    const attempt: Attempt = { error: undefined, done: false };
    promise.then(
        () => {
            attempt.done = true;
        },
        (err: unknown) => {
            attempt.done = true;
            attempt.error = err instanceof Error ? err : new Error(String(err));
        },
    );
    return attempt;
}

/**
 * Minimal transport for the clock tests: open, writable, and a read that
 * never resolves — a backend that never replies, so the ONLY thing that can
 * settle the request is the (virtual) timeout timer.
 */
class HangingTransport extends EventEmitter {
    public closed = false;
    public readonly id = "hanging" as const;
    public readonly state = { state: "open" } as const;
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

describe("systemClock (default Clock)", () => {
    it("delegates now() to the platform wall clock", () => {
        // Loose bounds: this pins the delegation, not clock precision.
        const before = Date.now();
        const read = systemClock.now();
        const after = Date.now();
        expect(read).toBeGreaterThanOrEqual(before);
        expect(read).toBeLessThanOrEqual(after);
    });

    it("monotonic() never goes backwards", () => {
        const a = systemClock.monotonic();
        const b = systemClock.monotonic();
        expect(b).toBeGreaterThanOrEqual(a);
    });

    it("sleep resolves via the platform timer", async () => {
        await systemClock.sleep(0);
    });

    it("setTimeout fires and clearTimeout cancels", async () => {
        let fired = false;
        const handle = systemClock.setTimeout(5, () => {
            fired = true;
        });
        systemClock.clearTimeout(handle);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(fired).toBe(false);
        systemClock.setTimeout(5, () => {
            fired = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(fired).toBe(true);
    });
});

describe("clock resolution — options.clock ?? platform.time ?? systemClock", () => {
    it("honors platform.time when no options.clock is given", async () => {
        const platformClock = new ManualClock();
        const client = createClient({
            events: stubEvents(),
            // Only the time bundle — contracts 0.2.7 Platform bundles are
            // each independently optional, and the transportFactory seam
            // bypasses everything the request path would otherwise need.
            platform: { time: platformClock },
            transportFactory: () => new HangingTransport(),
            timeoutMs: 400,
            idleTimeoutMs: 0,
        });
        try {
            const attempt = track(client.fetch("http://example.com/hang"));
            await drain();
            // The request budget armed on the PLATFORM clock, virtually.
            expect(platformClock.arms).toEqual([400]);
            expect(attempt.done).toBe(false);
            // Settle the request on virtual time before close, else pool.drain
            // would wait forever on the never-replying in-flight connection.
            platformClock.advance(400);
            await drain();
            expect(attempt.done).toBe(true);
        } finally {
            await client.close();
        }
    });

    it("an explicit options.clock wins over platform.time", async () => {
        const optionClock = new ManualClock();
        const platformClock = new ManualClock();
        const client = createClient({
            events: stubEvents(),
            clock: optionClock,
            platform: { time: platformClock },
            transportFactory: () => new HangingTransport(),
            timeoutMs: 400,
            idleTimeoutMs: 0,
        });
        try {
            const attempt = track(client.fetch("http://example.com/hang"));
            await drain();
            expect(optionClock.arms).toEqual([400]);
            expect(platformClock.arms).toEqual([]);
            expect(attempt.done).toBe(false);
            // Settle on the WINNING clock; the platform clock never moves.
            optionClock.advance(400);
            await drain();
            expect(attempt.done).toBe(true);
            expect(platformClock.pendingCount).toBe(0);
        } finally {
            await client.close();
        }
    });
});

describe("whole-request timeout on an injected Clock", () => {
    it("fires FetchTimeoutError at exactly timeoutMs of virtual time", async () => {
        const clock = new ManualClock();
        const client = createClient({
            events: stubEvents(),
            clock,
            transportFactory: () => new HangingTransport(),
            timeoutMs: 500,
            // Disable pool idle eviction so the request budget is the ONLY
            // virtual timer — the arms assertion stays exact.
            idleTimeoutMs: 0,
        });
        try {
            const attempt = track(client.fetch("http://example.com/slow"));
            await drain();
            expect(clock.arms).toEqual([500]);
            expect(attempt.done).toBe(false);

            clock.advance(499);
            await drain();
            expect(attempt.done).toBe(false); // held at N-1 — impossible under a real timer

            clock.advance(1);
            await drain();
            expect(attempt.done).toBe(true);
            expect(attempt.error).toBeInstanceOf(FetchTimeoutError);
            expect(attempt.error?.message).toMatch(/timed out after 500ms/);
            // Both timer lifecycles closed out: the request timer cleared in
            // the dispatch finally, nothing left armed on the virtual clock.
            expect(clock.pendingCount).toBe(0);
        } finally {
            await client.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Pool-level idle eviction on an injected Clock (createPool directly).
// ---------------------------------------------------------------------------

class StubTransport extends EventEmitter {
    public closed = false;
    public readonly id = "stub" as const;
    public readonly state = { state: "open" } as const;
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

describe("pool idle eviction on an injected Clock", () => {
    it("evicts at exactly idleTimeoutMs of virtual time after release", async () => {
        const clock = new ManualClock();
        const transports: StubTransport[] = [];
        const pool: ConnectionPool = createPool(
            {
                idleTimeoutMs: 300,
                events: stubEvents(),
                clock,
                transportFactory: () => {
                    const t = new StubTransport();
                    transports.push(t);
                    return t;
                },
            },
            lookup,
            fallbackProfile(),
        );
        const url = parseUrl("http://example.com/");
        try {
            await pool.getConnection(url, undefined);
            expect(transports).toHaveLength(1);
            pool.release(url);
            // Armed twice (establish + release-reset) but exactly ONE timer
            // is live — the reset cancelled the establish-time arming.
            expect(clock.arms).toEqual([300, 300]);
            expect(clock.pendingCount).toBe(1);

            clock.advance(299);
            await drain();
            expect(transports[0]?.closed).toBe(false); // 1ms short — still pooled

            clock.advance(1);
            await drain();
            expect(transports[0]?.closed).toBe(true); // evicted + closed

            // After eviction a new acquire must re-establish (its own fresh
            // idle timer is armed by the establish — exactly one pending).
            await pool.getConnection(url, undefined);
            expect(transports).toHaveLength(2);
            expect(clock.pendingCount).toBe(1);
        } finally {
            await pool.drain();
        }
    });

    it("re-release restarts the idle deadline from the later instant", async () => {
        const clock = new ManualClock();
        const transports: StubTransport[] = [];
        const pool: ConnectionPool = createPool(
            {
                idleTimeoutMs: 300,
                events: stubEvents(),
                clock,
                transportFactory: () => {
                    const t = new StubTransport();
                    transports.push(t);
                    return t;
                },
            },
            lookup,
            fallbackProfile(),
        );
        const url = parseUrl("http://example.com/");
        try {
            await pool.getConnection(url, undefined);
            pool.release(url);
            clock.advance(200);
            // Take + release inside the window: the deadline restarts from HERE.
            await pool.getConnection(url, undefined);
            pool.release(url);

            clock.advance(299);
            await drain();
            expect(transports[0]?.closed).toBe(false); // 299ms since the re-release

            clock.advance(1);
            await drain();
            expect(transports[0]?.closed).toBe(true);
            expect(transports).toHaveLength(1); // never re-established mid-test
        } finally {
            await pool.drain();
        }
    });

    it("drain cancels armed virtual idle timers", async () => {
        const clock = new ManualClock();
        const pool: ConnectionPool = createPool(
            {
                idleTimeoutMs: 300,
                events: stubEvents(),
                clock,
                transportFactory: () => new StubTransport(),
            },
            lookup,
            fallbackProfile(),
        );
        const url = parseUrl("http://example.com/");
        await pool.getConnection(url, undefined);
        pool.release(url);
        expect(clock.pendingCount).toBe(1);
        await pool.drain();
        clock.advance(1_000_000);
        expect(clock.pendingCount).toBe(0); // drain cleared the timer, nothing fired
    });
});
