import { describe, expect, it } from "vitest";
import { ParsedHeadersImpl } from "@browsercore/http1";
import {
    bodyKind,
    buildResponse,
    decompressBody,
    readContentEncoding,
} from "../src/response.js";
import { FetchError } from "../src/errors.js";
import { compression } from "./helpers/test-compression.js";

function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/** Build a real http1 `ParsedHeaders` container from ordered wire pairs. */
const headers = (entries: Array<[string, string]>): ParsedHeadersImpl =>
    new ParsedHeadersImpl(entries.map(([name, value]) => ({ name, value })));

describe("buildResponse — getSetCookie", () => {
    it("exposes every set-cookie value verbatim in wire order (case-insensitive name)", () => {
        const resp = buildResponse(
            "https://e.com/x",
            200,
            "OK",
            headers([
                ["set-cookie", "a=1"],
                ["Set-Cookie", "b=2"],
                ["content-type", "text/html"],
                ["SET-COOKIE", "c=3"],
            ]),
            utf8("body"),
            undefined,
            undefined,
        );
        expect(resp.getSetCookie()).toEqual(["a=1", "b=2", "c=3"]);
    });

    it("never comma-joins — a comma-bearing Expires value stays one verbatim entry", () => {
        const withDate = "theme=dark; Expires=Wed, 13 Jan 2027 07:28:00 GMT; Path=/";
        const resp = buildResponse(
            "https://e.com/",
            200,
            "OK",
            headers([
                ["set-cookie", "sid=abc; Path=/; HttpOnly"],
                ["set-cookie", withDate],
            ]),
            utf8("body"),
            undefined,
            undefined,
        );
        expect(resp.getSetCookie()).toEqual(["sid=abc; Path=/; HttpOnly", withDate]);
    });

    it("returns an empty array when no set-cookie is present", () => {
        const resp = buildResponse("https://e.com/", 200, "OK", headers([["x", "y"]]), utf8("body"), undefined, undefined);
        expect(resp.getSetCookie()).toEqual([]);
    });
});

describe("buildResponse — getHeaderValues", () => {
    it("returns every value of a repeated field in wire order, case-insensitively", () => {
        const resp = buildResponse(
            "https://e.com/",
            200,
            "OK",
            headers([
                ["x-tag", "one"],
                ["content-type", "text/plain"],
                ["X-TAG", "two"],
            ]),
            utf8("body"),
            undefined,
            undefined,
        );
        expect(resp.getHeaderValues("x-tag")).toEqual(["one", "two"]);
        expect(resp.getHeaderValues("X-Tag")).toEqual(["one", "two"]);
        expect(resp.getHeaderValues("x-missing")).toEqual([]);
    });

    it("keeps the flat headers record last-wins (compat) while the fidelity view sees both", () => {
        const resp = buildResponse(
            "https://e.com/",
            200,
            "OK",
            headers([
                ["set-cookie", "first=1"],
                ["set-cookie", "second=2"],
            ]),
            utf8("body"),
            undefined,
            undefined,
        );
        expect(resp.headers["set-cookie"]).toBe("second=2");
        expect(resp.getSetCookie()).toEqual(["first=1", "second=2"]);
    });

    it("clone() preserves the multi-value view", () => {
        const resp = buildResponse(
            "https://e.com/",
            200,
            "OK",
            headers([
                ["set-cookie", "a=1"],
                ["set-cookie", "b=2"],
            ]),
            utf8("once"),
            undefined,
            undefined,
        );
        const copy = resp.clone();
        expect(copy.getSetCookie()).toEqual(["a=1", "b=2"]);
        expect(copy.getHeaderValues("set-cookie")).toEqual(["a=1", "b=2"]);
    });
});

describe("readContentEncoding", () => {
    it("returns the encoding value case-insensitively", () => {
        expect(readContentEncoding(headers([["Content-Encoding", "gzip"]]))).toBe("gzip");
        expect(readContentEncoding(headers([["CONTENT-ENCODING", "br"]]))).toBe("br");
    });

    it("returns undefined when absent", () => {
        expect(readContentEncoding(headers([["x", "y"]]))).toBeUndefined();
        expect(readContentEncoding(new Map())).toBeUndefined();
    });

    it("returns the value of the content-encoding key (Map dedupes identical keys)", () => {
        // A Map keyed by the same name keeps only the last set value, so this
        // exercises the single-entry path rather than a multi-value merge.
        const h = headers([
            ["content-encoding", "gzip"],
            ["content-encoding", "br"],
        ]);
        expect(readContentEncoding(h)).toBe("br");
    });
});

describe("decompressBody", () => {
    it("returns the body unchanged when encoding is undefined", () => {
        const body = utf8("hello");
        // No encoding → returned as-is, no compression provider consulted.
        expect(decompressBody(compression, body, undefined)).toBe(body);
    });

    it("decompresses a gzip body through the compression package", () => {
        // Round-trip a gzip payload via the browser-tolerant decompressor.
        // We rely on @browsercore/compression being the inverse of itself via
        // the gzip format; verify the identity for a non-trivial payload.
        const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
        const original = utf8('{"a":1,"b":"text"}');
        const compressed = gzipSync(original);
        const out = decompressBody(compression, compressed, "gzip");
        expect(Array.from(out)).toEqual(Array.from(original));
    });

    it("throws when an encoding is set but no compression provider is injected", () => {
        // An encoded response with no injected provider is a configuration
        // error (Platform not provided) — surface a typed FetchError instead of
        // a confusing "compression.decompress is not a function" at decode time.
        const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
        const compressed = gzipSync(utf8("x"));
        expect(() => decompressBody(undefined, compressed, "gzip")).toThrow(FetchError);
    });
});

describe("bodyKind", () => {
    it("returns empty for undefined", () => {
        expect(bodyKind(undefined)).toEqual({ kind: "empty" });
    });

    it("encodes a string body to bytes", () => {
        const kind = bodyKind("hi");
        expect(kind.kind).toBe("bytes");
        if (kind.kind === "bytes") {
            expect(Array.from(kind.data)).toEqual([104, 105]); // 'h','i'
        }
    });

    it("passes a Uint8Array body through", () => {
        const data = utf8("abc");
        const kind = bodyKind(data);
        expect(kind.kind).toBe("bytes");
        if (kind.kind === "bytes") {
            expect(kind.data).toBe(data);
        }
    });
});

describe("buildResponse", () => {
    it("projects headers into a record and exposes status fields", () => {
        const resp = buildResponse(
            "https://e.com/x",
            200,
            "OK",
            headers([["content-type", "text/plain"]]),
            utf8("body"),
            undefined,
            undefined,
        );
        expect(resp.url).toBe("https://e.com/x");
        expect(resp.status).toBe(200);
        expect(resp.statusText).toBe("OK");
        expect(resp.headers["content-type"]).toBe("text/plain");
        expect(resp.bodyUsed).toBe(false);
    });

    it("text() consumes the body once and marks bodyUsed", async () => {
        const resp = buildResponse("https://e.com/", 200, "OK", headers([]), utf8("hello"), undefined, undefined);
        expect(await resp.text()).toBe("hello");
        expect(resp.bodyUsed).toBe(true);
    });

    it("body() rejects after a single consumption", async () => {
        const resp = buildResponse("https://e.com/", 200, "OK", headers([]), utf8("x"), undefined, undefined);
        await resp.body();
        expect(resp.bodyUsed).toBe(true);
        await expect(resp.body()).rejects.toBeInstanceOf(FetchError);
        await expect(resp.json()).rejects.toBeInstanceOf(FetchError);
        await expect(resp.text()).rejects.toBeInstanceOf(FetchError);
    });

    it("json() parses a UTF-8 JSON body", async () => {
        const resp = buildResponse(
            "https://e.com/",
            200,
            "OK",
            headers([]),
            utf8('{"a":1,"b":[2,3]}'),
            undefined,
            undefined,
        );
        expect(await resp.json()).toEqual({ a: 1, b: [2, 3] });
    });

    it("json() throws when the body is not valid JSON", async () => {
        const resp = buildResponse("https://e.com/", 200, "OK", headers([]), utf8("not json"), undefined, undefined);
        await expect(resp.json()).rejects.toThrow(SyntaxError);
    });

    it("body() returns the raw bytes", async () => {
        const bytes = utf8("raw");
        const resp = buildResponse("https://e.com/", 200, "OK", headers([]), bytes, undefined, undefined);
        const out = await resp.body();
        expect(Array.from(out)).toEqual(Array.from(bytes));
    });

    it("clone() yields an independent consumable copy", async () => {
        const resp = buildResponse("https://e.com/", 200, "OK", headers([]), utf8("once"), undefined, undefined);
        const copy = resp.clone();
        // Original and clone each consume independently.
        expect(await resp.text()).toBe("once");
        expect(await copy.text()).toBe("once");
        expect(resp.bodyUsed).toBe(true);
        expect(copy.bodyUsed).toBe(true);
    });

    it("decompresses the body when an encoding is supplied", async () => {
        const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
        const original = utf8("compressed payload");
        const resp = buildResponse(
            "https://e.com/",
            200,
            "OK",
            headers([["content-encoding", "gzip"]]),
            gzipSync(original),
            "gzip",
            compression,
        );
        expect(await resp.text()).toBe("compressed payload");
    });

    it("clone() preserves status, headers, and url", async () => {
        const resp = buildResponse(
            "https://e.com/x",
            201,
            "Created",
            headers([["content-type", "application/json"]]),
            utf8("1"),
            undefined,
            undefined,
        );
        const copy = resp.clone();
        expect(copy.url).toBe("https://e.com/x");
        expect(copy.status).toBe(201);
        expect(copy.statusText).toBe("Created");
        expect(copy.headers["content-type"]).toBe("application/json");
        await copy.body();
    });
});
