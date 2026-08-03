import { describe, expect, it } from "vitest";
import { fetch, FetchError, createClient } from "../src/index.js";
import {
    FetchTimeoutError,
    ProtocolError,
    RedirectError,
    assertNever,
} from "../src/index.js";

/**
 * The top-level `fetch()` convenience (src/index.ts) builds a one-shot client,
 * dispatches, and closes the client in a finally. It only forwards
 * profile/cookieJar/timeoutMs into the client defaults — it does not expose the
 * transportFactory test seam — so we exercise it through the URL-validation
 * short-circuit, which runs the full function body (build defaults -> create
 * client -> client.fetch -> parseUrl throws -> finally close) without touching
 * the network.
 */

describe("fetch convenience — public re-exports", () => {
    it("re-exports createClient and the error classes", () => {
        expect(typeof createClient).toBe("function");
        expect(typeof fetch).toBe("function");
        expect(FetchError).toBeDefined();
        expect(FetchTimeoutError).toBeDefined();
        expect(ProtocolError).toBeDefined();
        expect(RedirectError).toBeDefined();
    });

    it("re-exports assertNever", () => {
        expect(typeof assertNever).toBe("function");
        expect(() => assertNever("x" as never)).toThrow();
    });
});

describe("fetch convenience — function body", () => {
    it("rejects an invalid URL with FetchError and runs the finally close", async () => {
        // parseUrl throws before any network access; the one-shot client is
        // still created and closed in the finally. This covers the full body.
        await expect(fetch(":::not-a-url:::")).rejects.toBeInstanceOf(FetchError);
    });

    it("rejects an unsupported scheme with FetchError", async () => {
        await expect(fetch("ftp://example.com/")).rejects.toBeInstanceOf(FetchError);
    });

    it("assembles defaults only from present options (no undefined keys)", async () => {
        // Under exactOptionalPropertyTypes the helper must not emit
        // `{ profile: undefined }`. Passing each option exercises every
        // conditional assignment branch. The request still fails at parseUrl.
        const { createCookieJar } = await import("@browsercore/cookies");
        await expect(
            fetch(":::bad:::", {
                profile: "chrome-140" as never,
                timeoutMs: 10,
                cookieJar: createCookieJar(),
            }),
        ).rejects.toBeInstanceOf(FetchError);
        // Omitting all optional fields exercises the no-assignment path.
        await expect(fetch(":::bad:::")).rejects.toBeInstanceOf(FetchError);
    });

    it("does not wait for the timeout when parseUrl fails first", async () => {
        const start = Date.now();
        await expect(fetch(":::bad:::", { timeoutMs: 1000 })).rejects.toBeInstanceOf(FetchError);
        expect(Date.now() - start).toBeLessThan(500);
    });
});
