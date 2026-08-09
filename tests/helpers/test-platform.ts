/**
 * Test double for {@link Platform} — the composition root that fetch's runtime
 * dependencies are threaded through.
 *
 * The transportFactory test seam (client.test.ts, fetch.test.ts) bypasses the
 * real-TCP path, so net/dns/crypto/compression are never invoked there. They
 * are provided here so a single Platform can be injected wherever the full
 * resolution path (`options?.platform?.X`) is exercised. The crypto and
 * compression providers are the real `@browsercore/*` singletons — tests are
 * the one place that may wire concrete implementations directly.
 */

import { EventEmitter } from "node:events";
import type {
    EventProvider,
    Net,
    DnsResolver,
    Platform,
    Telemetry,
    Time,
    Clock,
    Scheduler,
} from "@browsercore/contracts";
import { crypto } from "@browsercore/crypto";
import { compression } from "./test-compression.js";

const net: Net = {
    connect: () => {
        throw new Error("test net stub: provide a transportFactory in tests");
    },
};

const dns: DnsResolver = {
    lookup: async () => [{ address: "127.0.0.1", family: 4 as const }],
};

const clock: Clock = {
    now: () => Date.now(),
    monotonic: () => BigInt(Date.now()) * 1_000_000n,
};

const scheduler: Scheduler = {
    delay: async () => {},
    timeout: () => new AbortController().signal,
    deadline: () => ({ signal: new AbortController().signal, expiresAt: 0n }),
};

const time: Time = { clock, scheduler };

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
        crypto: { provider: crypto },
        compression,
        events,
        telemetry,
        time,
    };
}
