import { describe, expect, it, vi } from "vitest";
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
import type { TlsConnection } from "@browsercore/tls";
import type { Transport } from "@browsercore/transport";
import type { BrowserProfile } from "@browsercore/profiles";
import { compression } from "./helpers/test-compression.js";
import { crypto as testCrypto } from "@browsercore/crypto";
import { stubEvents } from "./helpers/test-platform.js";

// Crypto provider for tests that exercise establishConnection directly. The
// real @browsercore/crypto singleton — the lower layers (connectTls/connectHttp2)
// are mocked here, so it is never invoked; production code receives it via
// Platform only.
const crypto = testCrypto;

// ---------------------------------------------------------------------------
// Top-level mocks for the lower-level @browsercore/* packages. These let us
// test establishConnection + openTcpTransport's ALPN-driven dispatch and TCP
// transport open path without a real network. The vi.fn() instances are
// configured per-test.
// ---------------------------------------------------------------------------

const mockConnectTls = vi.fn();
const mockConnectHttp1 = vi.fn();
const mockConnectHttp2 = vi.fn();
const mockConnectTransport = vi.fn();

vi.mock("@browsercore/tls", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/tls")>();
    return {
        ...actual,
        connectTls: (opts: unknown) => mockConnectTls(opts),
    };
});

vi.mock("@browsercore/http1", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/http1")>();
    return {
        ...actual,
        connectHttp1: (opts: unknown) => mockConnectHttp1(opts),
    };
});

vi.mock("@browsercore/http2", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/http2")>();
    return {
        ...actual,
        connectHttp2: (opts: unknown) => mockConnectHttp2(opts),
    };
});

vi.mock("@browsercore/transport", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/transport")>();
    return {
        ...actual,
        connect: (opts: unknown) => mockConnectTransport(opts),
    };
});

const fakeProfile = (): BrowserProfile =>
    ({
        id: "chrome" as const,
        name: "chrome",
        version: "140.0.0",
        tls: {
            cipherSuites: ["TLS_AES_128_GCM_SHA256"],
            extensionOrder: [0, 10, 11, 13, 16, 23, 27, 35, 43, 45, 51, 65281],
            supportedVersions: ["TLS 1.3"],
            keyShareGroups: ["x25519"],
            signatureAlgorithms: ["ecdsa_secp256r1_sha256"],
            grease: false,
        },
        http2: {
            settings: {
                headerTableSize: 65536,
                enablePush: false,
                maxConcurrentStreams: 100,
                initialWindowSize: 6291456,
                maxFrameSize: 16384,
                maxHeaderListSize: 65536,
            },
            initialWindowSize: 6291456,
            maxFrameSize: 16384,
            headerTableSize: 65536,
            weight: 256,
            // Impersonation vectors (Wave 0/1) — absent from the installed
            // profiles type, so the whole object is widened via `as`.
            settingsOrder: [1, 2, 4, 6],
            grease: true,
            connectionWindowUpdate: 15663105,
            pseudoHeaderOrder: ["method", "authority", "scheme", "path"],
        },
        http1: {
            defaultHeaders: { "user-agent": "test" },
            headerOrder: [],
            connection: "keep-alive",
            acceptEncoding: "gzip, deflate, br",
        },
    }) as BrowserProfile;

function fakeTlsConn(alpnProtocol: string | undefined): TlsConnection {
    const { EventEmitter } = require("node:events") as typeof import("node:events");
    return Object.assign(new EventEmitter(), {
        alpnProtocol,
        id: "tls-fake",
        state: { state: "open" },
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue({ payload: new Uint8Array() }),
        close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as TlsConnection;
}

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

describe("dispatchHttp1 — header casing", () => {
    it("forwards the headerCasing mode onto the HttpRequest", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("https://e.com/"), "GET", new Map(), undefined, undefined, "title");
        expect((conn.requests[0] as { headerCasing?: string }).headerCasing).toBe("title");
    });

    it("omits headerCasing when none is supplied (http1 applies its own default)", async () => {
        const conn = fakeHttp1(() => okResponse());
        await dispatchHttp1(conn, url("https://e.com/"), "GET", new Map(), undefined);
        expect((conn.requests[0] as { headerCasing?: string }).headerCasing).toBeUndefined();
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

    it("does not double-decompress when http1 returns a decompressed body with content-encoding set", async () => {
        // http1's decodeBody decompresses in-place and leaves the content-encoding
        // header on the response. dispatchHttp1 must NOT decompress again — it
        // passes `undefined` encoding to buildResponse. Simulate this by returning
        // a plaintext body with content-encoding: gzip still set (what http1
        // produces post-decode). If fetch decompressed again, the bytes would be
        // corrupt and text() would throw or return garbage.
        const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
        const original = new TextEncoder().encode("already-decompressed-by-http1");
        // http1 decompresses, so the body arriving at dispatchHttp1 is plaintext.
        const conn = fakeHttp1(() => ({
            statusCode: 200,
            statusText: "OK",
            headers: new Map([["content-encoding", "gzip"]]),
            body: original,
        }));
        const resp = await dispatchHttp1(conn, url("https://e.com/"), "GET", new Map(), undefined);
        expect(resp.headers["content-encoding"]).toBe("gzip");
        expect(await resp.text()).toBe("already-decompressed-by-http1");
        // A naive double-decompress would feed these plaintext bytes to gunzip,
        // throwing Z_DATA_ERROR ("incorrect header check").
    });

    it("http2 still decompresses when content-encoding is set (contrast with http1)", async () => {
        // HTTP/2 does not touch content-encoding, so the body arrives still
        // compressed and dispatchHttp2 must decompress it. This is the counterpart
        // to the http1 test above — the two dispatch paths are asymmetric.
        const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
        const original = new TextEncoder().encode("h2-still-compressed");
        const conn = fakeHttp2(() => ({
            statusCode: 200,
            headers: new Map([["content-encoding", "gzip"]]),
            body: gzipSync(original),
        }));
        const resp = await dispatchHttp2(conn, url("https://e.com/"), "GET", new Map(), undefined, compression);
        expect(await resp.text()).toBe("h2-still-compressed");
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
        const resp = await dispatchHttp2(conn, url("https://e.com/"), "GET", new Map(), undefined, compression);
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

        mockConnectHttp1.mockReset();
        mockConnectHttp1.mockResolvedValue({ id: "h1-stub", close: () => Promise.resolve() });

        const pooled = await establishHttp1OverTransport(stub);
        expect(pooled.protocol).toBe("http1");
        expect(typeof pooled.id).toBe("string");
        expect(pooled.conn).toBeDefined();
        await pooled.conn.close();
    });
});

// ---------------------------------------------------------------------------
// Tests for establishConnection + openTcpTransport — these exercise the
// ALPN-driven dispatch (h2 vs http/1.1) and the TCP transport open path.
// We mock the lower-level @browsercore/* packages so we can drive the
// branches without a real network.
// ---------------------------------------------------------------------------

import { establishConnection, openTcpTransport } from "../src/dispatch.js";

describe("establishConnection — ALPN dispatch", () => {
    it("negotiates h2 and returns an http2 pooled connection when ALPN selects h2", async () => {
        mockConnectTls.mockReset();
        mockConnectHttp1.mockReset();
        mockConnectHttp2.mockReset();
        mockConnectTls.mockResolvedValue(fakeTlsConn("h2"));
        mockConnectHttp2.mockResolvedValue({ id: "h2-1", settings: {} });

        const result = await establishConnection(
            { id: "t" } as Transport,
            fakeProfile(),
            "example.com",
            stubEvents(),
            crypto,
        );
        expect(result.protocol).toBe("http2");
        expect(mockConnectTls).toHaveBeenCalledTimes(1);
        expect(mockConnectHttp2).toHaveBeenCalledTimes(1);
        expect(mockConnectHttp1).not.toHaveBeenCalled();
    });

    it("falls back to http/1.1 when ALPN selects http/1.1", async () => {
        mockConnectTls.mockReset();
        mockConnectHttp1.mockReset();
        mockConnectHttp2.mockReset();
        mockConnectTls.mockResolvedValue(fakeTlsConn("http/1.1"));
        mockConnectHttp1.mockResolvedValue({ id: "h1-1" });

        const result = await establishConnection(
            { id: "t" } as Transport,
            fakeProfile(),
            "example.com",
            stubEvents(),
            crypto,
        );
        expect(result.protocol).toBe("http1");
        expect(mockConnectTls).toHaveBeenCalledTimes(1);
        expect(mockConnectHttp1).toHaveBeenCalledTimes(1);
        expect(mockConnectHttp2).not.toHaveBeenCalled();
    });

    it("falls back to http/1.1 when ALPN is undefined (no negotiated protocol)", async () => {
        mockConnectTls.mockReset();
        mockConnectHttp1.mockReset();
        mockConnectHttp2.mockReset();
        mockConnectTls.mockResolvedValue(fakeTlsConn(undefined));
        mockConnectHttp1.mockResolvedValue({ id: "h1-2" });

        const result = await establishConnection(
            { id: "t" } as Transport,
            fakeProfile(),
            "example.com",
            stubEvents(),
            crypto,
        );
        expect(result.protocol).toBe("http1");
        expect(mockConnectTls).toHaveBeenCalledTimes(1);
        expect(mockConnectHttp1).toHaveBeenCalledTimes(1);
        expect(mockConnectHttp2).not.toHaveBeenCalled();
    });

    it("passes the profile impersonation config (settingsOrder, grease, window update, pseudo-header order) to connectHttp2", async () => {
        mockConnectTls.mockReset();
        mockConnectHttp2.mockReset();
        mockConnectTls.mockResolvedValue(fakeTlsConn("h2"));
        mockConnectHttp2.mockResolvedValue({ id: "h2-imp", settings: {} });

        await establishConnection(
            { id: "t" } as Transport,
            fakeProfile(),
            "example.com",
            stubEvents(),
            crypto,
        );

        expect(mockConnectHttp2).toHaveBeenCalledTimes(1);
        const opts = mockConnectHttp2.mock.calls[0]![0] as Record<string, unknown>;
        // SETTINGS values are seeded from the profile.
        expect(opts.initialSettings).toBeDefined();
        // Impersonation vectors flow through end-to-end.
        expect(opts.settingsOrder).toEqual([1, 2, 4, 6]);
        expect(opts.settingsGrease).toBe(true);
        expect(opts.connectionWindowUpdate).toBe(15663105);
        expect(opts.pseudoHeaderOrder).toEqual(["method", "authority", "scheme", "path"]);
        expect(opts.priorityFrames).toEqual([]);
    });
});

describe("openTcpTransport", () => {
    it("opens a TCP transport to the host/port from the URL using provided net/dns adapters", async () => {
        // Decoupled: adapters come from Platform, threaded through options.
        // No fallback to a global singleton — that was the steel chain.
        const net = { connect: vi.fn() } as never;
        const dns = { lookup: vi.fn() } as never;
        mockConnectTransport.mockReset();
        mockConnectTransport.mockResolvedValue({ id: "tcp-1" });

        const parsed = parseUrl("https://example.com:8443/path");
        const events = stubEvents();
        const result = await openTcpTransport(parsed, net, dns, events);
        expect(result).toEqual({ id: "tcp-1" });
        expect(mockConnectTransport).toHaveBeenCalledTimes(1);
        expect(mockConnectTransport).toHaveBeenCalledWith({
            host: "example.com",
            port: 8443,
            net,
            dns,
            events,
        });
    });

    it("throws FetchError when called without net/dns adapters", () => {
        mockConnectTransport.mockReset();
        const parsed = parseUrl("https://example.com:8443/path");
        expect(() => openTcpTransport(parsed)).toThrow(
            "openTcpTransport requires net and dns adapters",
        );
        expect(mockConnectTransport).not.toHaveBeenCalled();
    });
});
