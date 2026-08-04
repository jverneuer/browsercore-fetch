import { describe, expect, it } from "vitest";
import {
    AbortError,
    FetchError,
    FetchTimeoutError,
    ProtocolError,
    RedirectError,
    ensureFetchError,
} from "../src/errors.js";

describe("ensureFetchError", () => {
    it("returns an existing FetchError unchanged (no rewrap)", () => {
        const original = new FetchError("boom", { url: "https://a" });
        const out = ensureFetchError(original, { url: "https://b" });
        expect(out).toBe(original);
        // url is not overwritten on passthrough.
        expect(out.url).toBe("https://a");
    });

    it("wraps a generic Error as a FetchError with cause", () => {
        const underlying = new Error("network down");
        const out = ensureFetchError(underlying, { url: "https://x" });
        expect(out).toBeInstanceOf(FetchError);
        expect(out).not.toBe(underlying);
        expect(out.message).toBe("network down");
        expect(out.cause).toBe(underlying);
        expect(out.url).toBe("https://x");
    });

    it("wraps a subclass of Error (e.g. TypeError) preserving its message", () => {
        const out = ensureFetchError(new TypeError("bad arg"), {});
        expect(out).toBeInstanceOf(FetchError);
        expect(out.message).toBe("bad arg");
        expect(out.cause).toBeInstanceOf(TypeError);
    });

    it("wraps a bare string as a FetchError with that message", () => {
        const out = ensureFetchError("something broke", { url: "https://y" });
        expect(out).toBeInstanceOf(FetchError);
        expect(out.message).toBe("something broke");
        expect(out.url).toBe("https://y");
        expect(out.cause).toBeUndefined();
    });

    it("wraps a number (non-string, non-Error) as an 'unknown fetch error'", () => {
        const out = ensureFetchError(42, {});
        expect(out).toBeInstanceOf(FetchError);
        expect(out.message).toBe("unknown fetch error");
    });

    it("wraps null as an unknown fetch error", () => {
        const out = ensureFetchError(null, {});
        expect(out.message).toBe("unknown fetch error");
    });

    it("preserves a requestId when supplied", () => {
        const id = "fetch_abc" as never;
        const out = ensureFetchError(new Error("x"), { requestId: id });
        expect(out.requestId).toBe(id);
    });
});

describe("AbortError", () => {
    it("is a FetchError tagged with reason=aborted", () => {
        const err = new AbortError("request aborted", { url: "https://z" });
        expect(err).toBeInstanceOf(FetchError);
        expect(err.kind).toBe("FetchError");
        expect(err.name).toBe("AbortError");
        expect(err.url).toBe("https://z");
        expect(err.details.reason).toBe("aborted");
    });
});

describe("FetchTimeoutError", () => {
    it("embeds the timeout in the message and exposes timeoutMs", () => {
        const err = new FetchTimeoutError(12345);
        expect(err.timeoutMs).toBe(12345);
        expect(err.message).toContain("12345");
        expect(err.kind).toBe("FetchTimeoutError");
    });

    it("carries an optional cause", () => {
        const cause = new Error("timer");
        const err = new FetchTimeoutError(10, { cause });
        expect(err.cause).toBe(cause);
    });
});

describe("RedirectError", () => {
    it("defaults redirectCount to 0 when not supplied", () => {
        const err = new RedirectError("loop");
        expect(err.redirectCount).toBe(0);
        expect(err.location).toBeUndefined();
    });

    it("exposes location + redirectCount", () => {
        const err = new RedirectError("limit", { location: "https://n", redirectCount: 9 });
        expect(err.location).toBe("https://n");
        expect(err.redirectCount).toBe(9);
        expect(err.kind).toBe("RedirectError");
    });

    it("carries an optional cause", () => {
        const cause = new Error("underlying");
        const err = new RedirectError("loop", { cause });
        expect(err.cause).toBe(cause);
        expect(err.message).toBe("loop");
    });

    it("does not set cause on super when no cause is supplied", () => {
        const err = new RedirectError("loop", { location: "https://x" });
        expect(err.cause).toBeUndefined();
    });
});

describe("ProtocolError", () => {
    it("defaults offeredProtocols to empty and selectedProtocol to undefined", () => {
        const err = new ProtocolError("none");
        expect(err.offeredProtocols).toEqual([]);
        expect(err.selectedProtocol).toBeUndefined();
    });

    it("exposes offeredProtocols + selectedProtocol", () => {
        const err = new ProtocolError("no overlap", {
            offeredProtocols: ["h2", "http/1.1"],
            selectedProtocol: "h2",
        });
        expect(err.offeredProtocols).toEqual(["h2", "http/1.1"]);
        expect(err.selectedProtocol).toBe("h2");
        expect(err.kind).toBe("ProtocolError");
    });

    it("carries an optional cause", () => {
        const cause = new Error("handshake failed");
        const err = new ProtocolError("none", { cause });
        expect(err.cause).toBe(cause);
    });

    it("does not set cause on super when no cause is supplied", () => {
        const err = new ProtocolError("none", { selectedProtocol: "http/1.1" });
        expect(err.cause).toBeUndefined();
    });
});

describe("FetchError base", () => {
    it("defaults details to {} when not supplied", () => {
        expect(new FetchError("x").details).toEqual({});
    });

    it("does not set cause on super when no cause is supplied", () => {
        // Some Node versions keep Error.cause undefined only if the options
        // object is omitted; the constructor passes undefined intentionally.
        const err = new FetchError("x", { url: "https://u" });
        expect(err.cause).toBeUndefined();
    });
});
