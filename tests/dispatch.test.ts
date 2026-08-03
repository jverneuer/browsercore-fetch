import { describe, expect, it } from "vitest";
import type {
    Http1Connection,
    Http1ConnectionId,
    Http1ConnectionState,
    HttpBodyKind,
    HttpMethod,
    HttpRequest,
    HttpResponse,
} from "@browsercore/http1";
import type {
    Http2Connection,
    Http2Request,
    Http2Response,
} from "@browsercore/http2";
import {
    dispatchHttp1,
    dispatchHttp2,
    establishHttp1OverTransport,
} from "../src/dispatch.js";
import { FetchError } from "../src/errors.js";
import { parseUrl } from "../src/url.js";
import type { ParsedUrl } from "../src/types.js";

/** Build a ParsedUrl from a string for dispatch calls. */
function url(s: string): ParsedUrl {
    return parseUrl(s);
}

// ---------------------------------------------------------------------------
// Fake HTTP/1.1 + HTTP/2 connections. They record the request and resolve a
// caller-controlled response so each test can assert exactly what hit the wire.
// ---------------------------------------------------------------------------

function fakeHttp1(
    respond: (req: HttpRequest) => HttpResponse,
): Http1Connection & { requests: HttpRequest[] } {
    const requests: HttpRequest[] = [];
    return {
        id: "h1-fake" as Http1ConnectionId,
        state: { state: "idle" } as Http1ConnectionState,
        async request(req: HttpRequest): Promise<HttpResponse> {
            requests.push(req);
            return respond(req);
        },
        async close(): Promise<void> {},
        requests,
    } as Http1Connection & { requests: HttpRequest[] };
}

function fakeHttp2(
    respond: (req: Http2Request) => Http2Response,
): Http2Connection & { requests: Http2Request[] } {
    const requests: Http2Request[] = [];
    return {
        id: "h2-fake",
        settings: {},
        async request(req: Http2Request): Promise<Http2Response> {
            requests.push(req);
            return respond(req);
        },
        async goaway(): Promise<void> {},
        async ping(): Promise<bigint> {
            return 0n;
        },
        async close(): Promise<void> {},
        requests,
    } as Http2Connection & { requests: Http2Request[] };
}

const okResponse = (body = ""): HttpResponse => ({
    statusCode: 200,
    statusText: "OK",
    headers: new Map(),
    body: new TextEncoder().encode(body),
});

const okH2Response = (body = ""): Http2Response => ({
    statusCode: 200,
    headers: new Map(),
    body: new TextEncoder().encode(body),
});

describe("dispatchHttp1 — host header", () => {
    it("adds a host header on the default port (no :port suffix)", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("https://example.com/"), "GET", new Map(), undefined);
        expect(conn.requests[0]?.headers.get("host")).toBe("example.com");
    });

    it("adds a host header including a non-default port", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("http://example.com:8080/"), "GET", new Map(), undefined);
        expect(conn.requests[0]?.headers.get("host")).toBe("example.com:8080");
    });

    it("does not overwrite a caller-supplied host header", async () => {
        const conn = fakeHttp1(() => okResponse());
        const headers = new Map([["host", "override.example"]]);
        await dispatchHttp1(conn, url("https://example.com/"), "GET", headers, undefined);
        expect(conn.requests[0]?.headers.get("host")).toBe("override.example");
    });
});

describe("dispatchHttp1 — content-length", () => {
    it("sets content-length from a string body when none is present", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("https://e.com/"), "POST", new Map(), "hello");
        const req = conn.requests[0]!;
        expect(req.headers.get("content-length")).toBe("5");
        expect(req.body.kind).toBe("bytes");
    });

    it("sets content-length from a Uint8Array body", async () => {
        const conn = fakeHttp1(() => okResponse());
        const body = new Uint8Array([1, 2, 3, 4]);
        await dispatchHttp1(conn, url("https://e.com/"), "POST", new Map(), body);
        expect(conn.requests[0]?.headers.get("content-length")).toBe("4");
    });

    it("does not set content-length when transfer-encoding is present", async () => {
        const conn = fakeHttp1(() => okResponse());
        const headers = new Map([["transfer-encoding", "chunked"]]);
        await dispatchHttp1(conn, url("https://e.com/"), "POST", headers, "body");
        expect(conn.requests[0]?.headers.get("content-length")).toBeUndefined();
    });

    it("does not overwrite a caller-supplied content-length", async () => {
        const conn = fakeHttp1(() => okResponse());
        const headers = new Map([["content-length", "99"]]);
        await dispatchHttp1(conn, url("https://e.com/"), "POST", headers, "body");
        expect(conn.requests[0]?.headers.get("content-length")).toBe("99");
    });

    it("omits content-length entirely when there is no body", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("https://e.com/"), "GET", new Map(), undefined);
        expect(conn.requests[0]?.headers.get("content-length")).toBeUndefined();
        expect(conn.requests[0]?.body.kind).toBe("empty");
    });
});

describe("dispatchHttp1 — request target", () => {
    it("passes the path + query as the wire url", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("https://e.com/a/b?x=1"), "GET", new Map(), undefined);
        expect(conn.requests[0]?.url).toBe("/a/b?x=1");
    });
});

describe("dispatchHttp1 — response building", () => {
    it("builds a FetchResponse with url/status/body and undefined encoding (http1 decompresses)", async () => {
        const conn = fakeHttp1(() => ({
            statusCode: 201,
            statusText: "Created",
            headers: new Map([["content-type", "text/plain"]]),
            body: new TextEncoder().encode("body"),
        }));
        const resp = await dispatchHttp1(conn, url("https://e.com/x"), "GET", new Map(), undefined);
        expect(resp.status).toBe(201);
        expect(resp.statusText).toBe("Created");
        expect(resp.url).toBe("https://e.com/x");
        expect(resp.headers["content-type"]).toBe("text/plain");
        expect(await resp.text()).toBe("body");
    });

    it("passes an empty body kind for GET/HEAD (no body)", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("https://e.com/"), "GET", new Map(), undefined);
        const kind = conn.requests[0]?.body as HttpBodyKind;
        expect(kind.kind).toBe("empty");
    });
});

describe("dispatchHttp1 — method validation", () => {
    it("accepts every FetchMethod", async () => {
        for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
            const conn = fakeHttp1(() => okResponse());
            await dispatchHttp1(conn, url("https://e.com/"), m, new Map(), undefined);
            expect(conn.requests[0]?.method).toBe(m as HttpMethod);
        }
    });

    it("rejects an unsupported method with FetchError before dispatching", async () => {
        const conn = fakeHttp1(() => okResponse());
        await expect(
            dispatchHttp1(conn, url("https://e.com/"), "TRACE", new Map(), undefined),
        ).rejects.toBeInstanceOf(FetchError);
        // Nothing hit the wire.
        expect(conn.requests).toHaveLength(0);
        try {
            await dispatchHttp1(conn, url("https://e.com/"), "WAT", new Map(), undefined);
        } catch (err) {
            expect((err as FetchError).message).toContain("unsupported HTTP method");
            expect((err as FetchError).details.method).toBe("WAT");
        }
    });
});

describe("dispatchHttp2 — pseudo-headers", () => {
    it("sets :method, :path, :scheme, :authority on the default port", async () => {
        const conn = fakeHttp2(() => okH2Response());
        await dispatchHttp2(conn, url("https://example.com/a?x=1"), "GET", new Map(), undefined);
        const h = conn.requests[0]?.headers;
        expect(h?.get(":method")).toBe("GET");
        expect(h?.get(":path")).toBe("/a?x=1");
        expect(h?.get(":scheme")).toBe("https");
        expect(h?.get(":authority")).toBe("example.com");
    });

    it("includes the port in :authority when non-default", async () => {
        const conn = fakeHttp2(() => okH2Response());
        await dispatchHttp2(conn, url("http://example.com:9000/"), "GET", new Map(), undefined);
        expect(conn.requests[0]?.headers.get(":authority")).toBe("example.com:9000");
        expect(conn.requests[0]?.headers.get(":scheme")).toBe("http");
    });

    it("does not overwrite caller-supplied pseudo-headers", async () => {
        const conn = fakeHttp2(() => okH2Response());
        const headers = new Map([
            [":method", "POST"],
            [":path", "/custom"],
            [":scheme", "https"],
            [":authority", "custom.example"],
        ]);
        await dispatchHttp2(conn, url("https://example.com/"), "GET", headers, undefined);
        const h = conn.requests[0]?.headers;
        expect(h?.get(":method")).toBe("POST");
        expect(h?.get(":path")).toBe("/custom");
        expect(h?.get(":authority")).toBe("custom.example");
    });

    it("also passes method/scheme/authority/path as the structured request fields", async () => {
        const conn = fakeHttp2(() => okH2Response());
        await dispatchHttp2(conn, url("https://e.com:8443/p"), "POST", new Map(), "data");
        const req = conn.requests[0]!;
        expect(req.method).toBe("POST");
        expect(req.scheme).toBe("https");
        expect(req.authority).toBe("e.com:8443");
        expect(req.path).toBe("/p");
    });
});

describe("dispatchHttp2 — body encoding", () => {
    it("encodes a string body to bytes", async () => {
        const conn = fakeHttp2(() => okH2Response());
        await dispatchHttp2(conn, url("https://e.com/"), "POST", new Map(), "abc");
        expect(conn.requests[0]?.body).toEqual(new TextEncoder().encode("abc"));
    });

    it("passes a Uint8Array body through unchanged", async () => {
        const conn = fakeHttp2(() => okH2Response());
        const body = new Uint8Array([9, 9, 9]);
        await dispatchHttp2(conn, url("https://e.com/"), "POST", new Map(), body);
        expect(conn.requests[0]?.body).toBe(body);
    });

    it("passes undefined body through as undefined", async () => {
        const conn = fakeHttp2(() => okH2Response());
        await dispatchHttp2(conn, url("https://e.com/"), "GET", new Map(), undefined);
        expect(conn.requests[0]?.body).toBeUndefined();
    });
});

describe("dispatchHttp2 — response building", () => {
    it("uses the response content-encoding to decompress", async () => {
        // HTTP/2 leaves the body compressed; dispatchHttp2 reads
        // content-encoding and hands it to buildResponse for decompression.
        const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
        const original = new TextEncoder().encode("h2 compressed");
        const conn = fakeHttp2(() => ({
            statusCode: 200,
            headers: new Map([["content-encoding", "gzip"]]),
            body: gzipSync(original),
        }));
        const resp = await dispatchHttp2(conn, url("https://e.com/"), "GET", new Map(), undefined);
        expect(await resp.text()).toBe("h2 compressed");
    });

    it("uses an empty status text for h2 (no status text on the wire)", async () => {
        const conn = fakeHttp2(() => okH2Response("x"));
        const resp = await dispatchHttp2(conn, url("https://e.com/"), "GET", new Map(), undefined);
        expect(resp.statusText).toBe("");
        expect(resp.status).toBe(200);
    });
});

describe("dispatchHttp2 — method passthrough", () => {
    it("does not validate the method (passes it through to the h2 layer)", async () => {
        // Note: unlike dispatchHttp1, dispatchHttp2 does not call asHttpMethod.
        // Method validation is delegated to the HTTP/2 connection layer; the
        // dispatcher forwards whatever string it was given. This records the
        // current contract so a future change is intentional.
        const conn = fakeHttp2(() => okH2Response());
        const resp = await dispatchHttp2(
            conn,
            url("https://e.com/"),
            "BOGUS" as never,
            new Map(),
            undefined,
        );
        expect(resp.status).toBe(200);
        expect(conn.requests[0]?.method).toBe("BOGUS");
        expect(conn.requests[0]?.headers.get(":method")).toBe("BOGUS");
    });
});

describe("establishHttp1OverTransport", () => {
    it("establishes an http1 pooled connection over a caller transport", async () => {
        // Use the in-memory paired transport from the existing test fixture
        // pattern: the http1 layer needs a Transport it can read/write. A
        // minimal stub that never receives bytes is enough to confirm the
        // pooled wrapper is constructed with protocol=http1.
        const { EventEmitter } = await import("node:events");
        const stub = new EventEmitter() as unknown as import("@browsercore/transport").Transport;
        Object.defineProperty(stub, "id", { value: "t-stub" });
        Object.defineProperty(stub, "state", { value: { state: "open" } });
        stub.write = () => Promise.resolve();
        stub.read = () => new Promise(() => {});
        stub.close = () => Promise.resolve();

        const pooled = await establishHttp1OverTransport(stub);
        expect(pooled.protocol).toBe("http1");
        expect(typeof pooled.id).toBe("string");
        expect(pooled.conn).toBeDefined();
        await pooled.conn.close();
    });
});
