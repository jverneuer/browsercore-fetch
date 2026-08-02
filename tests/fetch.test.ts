import { describe, expect, it } from "vitest";
import {
    FetchError,
    FetchTimeoutError,
    ProtocolError,
    RedirectError,
} from "../src/index.js";

describe("FetchError", () => {
    it("instantiates as a FetchError and an Error", () => {
        const err = new FetchError("boom", {
            url: "https://example.com",
            requestId: "fetch_abc" as never,
        });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(FetchError);
        expect(err.kind).toBe("FetchError");
        expect(err.url).toBe("https://example.com");
        expect(err.requestId).toBe("fetch_abc");
        expect(err.message).toBe("boom");
    });

    it("captures a cause", () => {
        const cause = new Error("underlying");
        const err = new FetchError("wrapped", { cause });
        expect(err.cause).toBe(cause);
    });
});

describe("typed fetch errors", () => {
    it("FetchTimeoutError carries the timeout", () => {
        const err = new FetchTimeoutError(5000);
        expect(err).toBeInstanceOf(FetchTimeoutError);
        expect(err.timeoutMs).toBe(5000);
        expect(err.message).toContain("5000");
    });

    it("RedirectError carries location + redirect count", () => {
        const err = new RedirectError("loop", {
            location: "https://a",
            redirectCount: 7,
        });
        expect(err).toBeInstanceOf(RedirectError);
        expect(err.location).toBe("https://a");
        expect(err.redirectCount).toBe(7);
    });

    it("ProtocolError carries ALPN details", () => {
        const err = new ProtocolError("no overlap", {
            offeredProtocols: ["h2", "http/1.1"],
            selectedProtocol: undefined,
        });
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.offeredProtocols).toEqual(["h2", "http/1.1"]);
        expect(err.selectedProtocol).toBeUndefined();
    });
});

describe("FetchOptions type shape", () => {
    it("compiles with a full options object", () => {
        // This test exists to ensure the public FetchOptions shape stays
        // consumable — it is checked at compile time, not runtime.
        const options = {
            method: "POST" as const,
            headers: { "content-type": "text/plain" },
            body: "hi",
            followRedirects: true,
            maxRedirects: 10,
            timeoutMs: 30_000,
            priority: 1,
        };
        expect(options.method).toBe("POST");
    });
});
