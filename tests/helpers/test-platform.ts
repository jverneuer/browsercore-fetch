/**
 * Test double for {@link Platform} — the composition root that fetch's runtime
 * dependencies are threaded through.
 *
 * The transportFactory test seam (client.test.ts, fetch.test.ts) bypasses the
 * real-TCP path, so net/dns/crypto/compression are never invoked there. They
 * are provided here so a single Platform can be injected wherever the full
 * resolution path (`options?.platform?.X`) is exercised. Crypto is the
 * deterministic test provider (test-crypto.ts) — the Node-backed provider
 * lives in browsersmith, and `@browsercore/crypto` exports no singleton.
 * Compression is the node:zlib-backed test provider.
 */

import { EventEmitter } from "node:events";
import type {
    EventProvider,
    Net,
    DnsResolver,
    Platform,
    Telemetry,
    Time,
    TimerHandle,
} from "@browsercore/contracts";
import { deterministicCrypto } from "./test-crypto.js";
import { compression } from "./test-compression.js";

const net: Net = {
    connect: () => {
        throw new Error("test net stub: provide a transportFactory in tests");
    },
};

const dns: DnsResolver = {
    lookup: async () => [{ address: "127.0.0.1", family: 4 as const }],
};

// contracts 0.2.7: `Time` IS the canonical Clock — the former
// { clock, scheduler } bundle shape is gone, and fetch now honors
// platform.time for its timers. Real-globals delegation; tests needing
// deterministic time inject a platform whose time is a manual clock.
const time: Time = {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    sleep: (ms) =>
        new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        }),
    setTimeout: (ms, fn) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout> as TimerHandle),
};

const telemetry: Telemetry = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    tracer: { startSpan: () => ({ setAttribute: () => ({ end: () => {} }), end: () => {} }) },
    metrics: { add: () => {} },
};

/**
 * Build a fresh stub {@link Platform}. A factory (not a shared constant) so each
 * test gets its own EventEmitter and cross-test listener leaks are impossible.
 */
/**
 * Build a fresh {@link EventProvider} (an EventEmitter) for tests that need
 * only an event surface — e.g. constructing a {@link TlsTransportAdapter}
 * directly. A factory, not a shared constant, so tests never share listeners.
 */
export function stubEvents(): EventProvider {
    return new EventEmitter();
}

export function createTestPlatform(): Platform {
    // EventEmitter structurally satisfies EventProvider (on/once/off/
    // removeListener/emit/listenerCount/removeAllListeners) — the surface
    // protocol code depends on. Built fresh per call so tests never share
    // listeners via a global emitter.
    const events: EventProvider = new EventEmitter();
    return {
        network: { tcp: net, dns },
        crypto: { provider: deterministicCrypto },
        compression,
        events,
        telemetry,
        time,
    };
}
