import { describe, expect, it } from "vitest";
import {
    cookieUrl,
    defaultPort,
    originString,
    parseUrl,
    poolKey,
    requestTarget,
    resolveRedirectUrl,
} from "../src/url.js";
import { FetchError } from "../src/errors.js";
import type { ParsedUrl } from "../src/types.js";

describe("defaultPort", () => {
    it("returns 80 for http", () => {
        expect(defaultPort("http")).toBe(80);
    });
    it("returns 443 for https", () => {
        expect(defaultPort("https")).toBe(443);
    });
});

describe("parseUrl", () => {
    it("parses a plain https URL with default port", () => {
        const u = parseUrl("https://example.com/path");
        expect(u).toEqual({
            scheme: "https",
            host: "example.com",
            port: 443,
            path: "/path",
            query: "",
            fragment: "",
        });
    });

    it("parses http with an explicit port, query, and fragment", () => {
        const u = parseUrl("http://example.com:8080/a/b?x=1&y=2#frag");
        expect(u.scheme).toBe("http");
        expect(u.host).toBe("example.com");
        expect(u.port).toBe(8080);
        expect(u.path).toBe("/a/b");
        expect(u.query).toBe("?x=1&y=2");
        expect(u.fragment).toBe("#frag");
    });

    it("defaults the path to '/' when none is given", () => {
        const u = parseUrl("https://example.com");
        expect(u.path).toBe("/");
    });

    it("rejects a malformed URL with FetchError carrying the cause", () => {
        try {
            parseUrl(":::not-a-url:::");
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(FetchError);
            const e = err as FetchError;
            expect(e.url).toBe(":::not-a-url:::");
            expect(e.message).toContain("invalid URL");
            expect(e.cause).toBeInstanceOf(Error);
        }
    });

    it("rejects an unsupported scheme with FetchError", () => {
        try {
            parseUrl("ftp://example.com/file");
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(FetchError);
            expect((err as FetchError).message).toContain("unsupported scheme");
            expect((err as FetchError).message).toContain("ftp");
        }
    });

    it("rejects a file: URL", () => {
        expect(() => parseUrl("file:///etc/hosts")).toThrow(FetchError);
    });

    it("rejects a bare string with no scheme", () => {
        expect(() => parseUrl("not-a-url-at-all")).toThrow(FetchError);
    });

    it("wraps a non-Error thrown by the URL parser without a cause", () => {
        // The URL constructor always throws an Error in practice, but the
        // parseUrl code path that handles a non-Error cause (lines 41-42)
        // must still be covered. We exercise it by stubbing URL to throw a
        // non-Error value.
        const origURL = globalThis.URL;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).URL = class {
            constructor() {
                throw "a string error, not an Error";
            }
        };
        try {
            expect(() => parseUrl("https://example.com")).toThrow(FetchError);
            try {
                parseUrl("https://example.com");
            } catch (err) {
                expect(err).toBeInstanceOf(FetchError);
                expect((err as FetchError).cause).toBeUndefined();
            }
        } finally {
            globalThis.URL = origURL;
        }
    });
});

describe("originString", () => {
    it("omits the port when it is the scheme default", () => {
        const u: ParsedUrl = {
            scheme: "https",
            host: "example.com",
            port: 443,
            path: "/",
            query: "",
            fragment: "",
        };
        expect(originString(u)).toBe("https://example.com");
    });

    it("includes a non-default port", () => {
        const u: ParsedUrl = {
            scheme: "http",
            host: "example.com",
            port: 8080,
            path: "/",
            query: "",
            fragment: "",
        };
        expect(originString(u)).toBe("http://example.com:8080");
    });
});

describe("requestTarget", () => {
    it("joins path + query", () => {
        const u: ParsedUrl = {
            scheme: "https",
            host: "e.com",
            port: 443,
            path: "/a",
            query: "?b=c",
            fragment: "",
        };
        expect(requestTarget(u)).toBe("/a?b=c");
    });

    it("is just the path when there is no query", () => {
        const u: ParsedUrl = {
            scheme: "https",
            host: "e.com",
            port: 443,
            path: "/a",
            query: "",
            fragment: "",
        };
        expect(requestTarget(u)).toBe("/a");
    });
});

describe("poolKey", () => {
    it("keys by host:port regardless of scheme/path", () => {
        const a = parseUrl("https://example.com:8443/a");
        const b = parseUrl("https://example.com:8443/b");
        expect(poolKey(a)).toBe(poolKey(b));
        expect(poolKey(a)).toBe("example.com:8443");
    });

    it("distinguishes different ports on the same host", () => {
        const a = parseUrl("http://example.com:80/x");
        const b = parseUrl("http://example.com:81/x");
        expect(poolKey(a)).not.toBe(poolKey(b));
    });
});

describe("resolveRedirectUrl", () => {
    const base = (): ParsedUrl => parseUrl("https://example.com/a/b");

    it("resolves a relative path against the current URL", () => {
        const next = resolveRedirectUrl(base(), "/c");
        expect(next.host).toBe("example.com");
        expect(next.path).toBe("/c");
        expect(next.scheme).toBe("https");
        expect(next.port).toBe(443);
    });

    it("resolves a relative segment", () => {
        const next = resolveRedirectUrl(base(), "c");
        expect(next.path).toBe("/a/c");
    });

    it("resolves an absolute URL of a different origin", () => {
        const next = resolveRedirectUrl(base(), "http://other.example:9000/x");
        expect(next.scheme).toBe("http");
        expect(next.host).toBe("other.example");
        expect(next.port).toBe(9000);
        expect(next.path).toBe("/x");
    });

    it("throws on an unsupported scheme (no silent coercion)", () => {
        // asScheme rejects anything non-http/https — a non-http Location is
        // never silently coerced to https, so a hostile redirect surfaces as
        // a FetchError rather than a request the server never intended.
        expect(() => resolveRedirectUrl(base(), "ftp://example.com/x")).toThrow(FetchError);
    });

    it("carries the query + fragment from the Location", () => {
        const next = resolveRedirectUrl(base(), "/c?x=1#top");
        expect(next.query).toBe("?x=1");
        expect(next.fragment).toBe("#top");
    });
});

describe("cookieUrl", () => {
    it("projects scheme/host/path into the cookie-jar shape", () => {
        const u = cookieUrl(parseUrl("https://example.com:8443/a/b?x=1"));
        // Port is intentionally not part of cookie matching.
        expect(u.hostname).toBe("example.com");
        expect(u.pathname).toBe("/a/b");
        expect(u.protocol).toBe("https:");
    });
});
