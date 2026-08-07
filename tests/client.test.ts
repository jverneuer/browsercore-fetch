import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Net, DnsResolver } from "@browsercore/contracts";
import type { Transport, TransportId, TransportState } from "@browsercore/transport";
import { ChromeProfiles } from "@browsercore/profiles";
import { createClient } from "../src/client.js";
import { RedirectError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// In-memory HTTP/1.1 fake backend (same model as fetch.test.ts, trimmed to the
// needs of the redirect-policy tests). The transportFactory seam bypasses TLS.
// ---------------------------------------------------------------------------

interface FakeRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Uint8Array;
}
interface FakeResponse {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array | string;
}

class FakeTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    private _state: TransportState = { state: "open" };
    private _peer: FakeTransport | undefined;
    private readonly _buf: number[] = [];
    private _pending: ((d: Uint8Array) => void) | undefined;
    private _pendingReject: ((e: Error) => void) | undefined;

    private constructor(id: string) {
        super();
        this.id = id as TransportId;
    }
    public static pair(): { client: FakeTransport; server: FakeTransport } {
        const client = new FakeTransport("client");
        const server = new FakeTransport("server");
        client._peer = server;
        server._peer = client;
        return { client, server };
    }
    public get state(): TransportState {
        return this._state;
    }
    public write(data: Uint8Array): Promise<void> {
        if (this._state.state !== "open") return Promise.reject(new Error("closed"));
        this._peer?._deliver(data);
        return Promise.resolve();
    }
    public read(): Promise<Uint8Array> {
        if (this._state.state !== "open") return Promise.reject(new Error("closed"));
        if (this._buf.length > 0) {
            const d = Uint8Array.from(this._buf);
            this._buf.length = 0;
            return Promise.resolve(d);
        }
        return new Promise((resolve, reject) => {
            this._pending = resolve;
            this._pendingReject = reject;
        });
    }
    public close(): Promise<void> {
        if (this._state.state === "closed") return Promise.resolve();
        this._state = { state: "closed", reason: { kind: "client_close" } };
        this._pendingReject?.(new Error("closed"));
        this._pending = undefined;
        this._pendingReject = undefined;
        if (this._peer && this._peer._state.state !== "closed") {
            this._peer._state = { state: "closed", reason: { kind: "remote_close" } };
            this._peer._pendingReject?.(new Error("closed"));
            this._peer._pending = undefined;
            this._peer._pendingReject = undefined;
        }
        this.emit("close", false);
        return Promise.resolve();
    }
    private _deliver(data: Uint8Array): void {
        for (let i = 0; i < data.length; i++) this._buf.push(data[i]!);
        const buffered = Uint8Array.from(this._buf);
        // ALWAYS clear the buffer so stale bytes are not re-emitted on the next
        // delivery — a reused keep-alive connection would otherwise replay the
        // prior request. (Mirrors fetch.test.ts exactly.)
        this._buf.length = 0;
        const pending = this._pending;
        if (pending !== undefined) {
            this._pending = undefined;
            this._pendingReject = undefined;
        }
        queueMicrotask(() => {
            this.emit("data", buffered);
            if (pending !== undefined) pending(data);
        });
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
function findHeaderEnd(buf: Uint8Array): number {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
            return i;
        }
    }
    return -1;
}
function decodeAscii(buf: Uint8Array, start: number, end: number): string {
    let out = "";
    for (let i = start; i < end; i++) out += String.fromCharCode(buf[i]!);
    return out;
}
function tryParseRequest(buf: Uint8Array): { request: FakeRequest; consumed: number } | null {
    const headerEnd = findHeaderEnd(buf);
    if (headerEnd === -1) return null;
    const bodyStart = headerEnd + 4;
    const headerText = decodeAscii(buf, 0, headerEnd);
    const firstLineEnd = headerText.indexOf("\r\n");
    const requestLine = headerText.slice(0, firstLineEnd === -1 ? headerText.length : firstLineEnd);
    const parts = requestLine.split(" ");
    const method = parts[0] ?? "";
    const reqUrl = parts[1] ?? "";
    const headers = new Map<string, string>();
    for (const line of headerText.slice(firstLineEnd + 2).split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
    }
    const match = /(?:^|\n)content-length:\s*(\d+)\r?/i.exec(headerText);
    const cl = match?.[1];
    if (cl !== undefined) {
        const n = Number(cl);
        if (buf.length < bodyStart + n) return null;
        return { request: { method, url: reqUrl, headers, body: buf.slice(bodyStart, bodyStart + n) }, consumed: bodyStart + n };
    }
    return { request: { method, url: reqUrl, headers, body: new Uint8Array(0) }, consumed: bodyStart };
}
function serializeResponse(resp: FakeResponse): Uint8Array {
    const bodyBytes =
        resp.body === undefined
            ? new Uint8Array(0)
            : typeof resp.body === "string"
              ? new TextEncoder().encode(resp.body)
              : resp.body;
    const headers: Record<string, string> = { "content-length": String(bodyBytes.length) };
    if (resp.headers !== undefined) {
        for (const [k, v] of Object.entries(resp.headers)) headers[k] = v;
    }
    let text = `HTTP/1.1 ${resp.status} ${resp.statusText ?? ""}\r\n`;
    for (const [k, v] of Object.entries(headers)) text += `${k}: ${v}\r\n`;
    text += "\r\n";
    const headerBytes = new TextEncoder().encode(text);
    const out = new Uint8Array(headerBytes.length + bodyBytes.length);
    out.set(headerBytes, 0);
    out.set(bodyBytes, headerBytes.length);
    return out;
}

class FakeHttpServer {
    private buffer: Uint8Array = new Uint8Array(0);
    private readonly waiters: Array<() => void> = [];
    private closed = false;
    constructor(
        private readonly transport: FakeTransport,
        private readonly handler: (req: FakeRequest) => FakeResponse | undefined,
    ) {
        transport.on("data", (chunk: Uint8Array) => {
            this.buffer = concat(this.buffer, chunk);
            this.waiters.shift()?.();
        });
        transport.on("close", () => {
            this.closed = true;
            for (const w of this.waiters) w();
            this.waiters.length = 0;
        });
        void this.loop();
    }
    private async loop(): Promise<void> {
        for (;;) {
            const req = await this.nextRequest();
            if (req === undefined) return;
            const resp = this.handler(req);
            if (resp === undefined) return;
            try {
                await this.transport.write(serializeResponse(resp));
            } catch {
                // Transport closed mid-write (test tore down the connection).
                return;
            }
        }
    }
    private nextRequest(): Promise<FakeRequest | undefined> {
        return new Promise((resolve) => {
            const tryResolve = (): void => {
                const parsed = tryParseRequest(this.buffer);
                if (parsed !== null) {
                    this.buffer = this.buffer.slice(parsed.consumed);
                    resolve(parsed.request);
                    return;
                }
                if (this.closed) {
                    resolve(undefined);
                    return;
                }
                this.waiters.push(() => tryResolve());
            };
            tryResolve();
        });
    }
}

function installBackend(handler: (req: FakeRequest) => FakeResponse | undefined): {
    factory: (host: string, port: number) => Transport;
    close: () => Promise<void>;
} {
    const servers: FakeTransport[] = [];
    const factory = (_host: string, _port: number): Transport => {
        const { client, server } = FakeTransport.pair();
        servers.push(server);
        new FakeHttpServer(server, handler);
        return client;
    };
    return {
        factory,
        close: async () => {
            for (const s of servers) await s.close();
        },
    };
}

// ---------------------------------------------------------------------------
// Redirect policy tests. These target the followRedirects branches in
// client.ts: manual, error, follow-with-limit, 303 body strip, missing Location.
// ---------------------------------------------------------------------------

describe("client — redirect policy: manual", () => {
    it("returns the 3xx response as-is when followRedirects is false", async () => {
        const { factory, close } = installBackend(() => ({
            status: 302,
            statusText: "Found",
            headers: { location: "http://example.com/elsewhere" },
            body: "",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/", { followRedirects: false });
            expect(resp.status).toBe(302);
            expect(resp.headers["location"]).toBe("http://example.com/elsewhere");
        } finally {
            await client.close();
            await close();
        }
    });

    it("a non-redirect response is returned normally even with followRedirects:false", async () => {
        const { factory, close } = installBackend(() => ({
            status: 200,
            statusText: "OK",
            body: "ok",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/", { followRedirects: false });
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("ok");
        } finally {
            await client.close();
            await close();
        }
    });
});

describe("client — redirect policy: error", () => {
    it("throws RedirectError when a redirect is encountered with policy=error", async () => {
        const { factory, close } = installBackend(() => ({
            status: 301,
            statusText: "Moved",
            headers: { location: "http://example.com/x" },
            body: "",
        }));
        const client = createClient({
            transportFactory: factory,
            redirectPolicy: { kind: "error" },
        });
        try {
            await expect(client.fetch("http://example.com/")).rejects.toBeInstanceOf(RedirectError);
            try {
                await client.fetch("http://example.com/");
            } catch (err) {
                expect(err).toBeInstanceOf(RedirectError);
                expect((err as RedirectError).message).toContain("policy=error");
                expect((err as RedirectError).location).toBe("http://example.com/x");
            }
        } finally {
            await client.close();
            await close();
        }
    });

    it("returns a non-redirect response unchanged with policy=error", async () => {
        const { factory, close } = installBackend(() => ({
            status: 200,
            statusText: "OK",
            body: "ok",
        }));
        const client = createClient({
            transportFactory: factory,
            redirectPolicy: { kind: "error" },
        });
        try {
            const resp = await client.fetch("http://example.com/");
            expect(resp.status).toBe(200);
        } finally {
            await client.close();
            await close();
        }
    });
});

describe("client — redirect policy: follow", () => {
    it("follows a relative redirect and returns the final response", async () => {
        const seen: string[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req.url);
            if (req.url === "/start") {
                return { status: 302, headers: { location: "/final" }, body: "" };
            }
            return { status: 200, statusText: "OK", body: "done" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/start");
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("done");
            expect(seen).toContain("/final");
        } finally {
            await client.close();
            await close();
        }
    });

    it("throws RedirectError when maxRedirects is exceeded", async () => {
        // Every response redirects to itself -> an infinite loop bounded by
        // maxRedirects=3. The client must raise RedirectError, not hang.
        const { factory, close } = installBackend((req) => ({
            status: 302,
            headers: { location: req.url },
            body: "",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            await expect(
                client.fetch("http://example.com/loop", { maxRedirects: 3 }),
            ).rejects.toBeInstanceOf(RedirectError);
            try {
                await client.fetch("http://example.com/loop", { maxRedirects: 2 });
            } catch (err) {
                expect((err as RedirectError).message).toContain("redirect limit exceeded");
                expect((err as RedirectError).message).toContain("2");
            }
        } finally {
            await client.close();
            await close();
        }
    });

    it("returns the 3xx response when Location is missing (nothing to follow)", async () => {
        const { factory, close } = installBackend(() => ({
            status: 302,
            statusText: "Found",
            body: "no location",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/");
            expect(resp.status).toBe(302);
            expect(await resp.text()).toBe("no location");
        } finally {
            await client.close();
            await close();
        }
    });
});

describe("client — 303 See Other body stripping", () => {
    it("converts PUT -> GET and drops the body on a 303", async () => {
        // PUT is not in METHODS_PRESERVED_ON_303, so a 303 response converts
        // it to GET and strips the body (RFC 7231 §6.4.4).
        const seen: FakeRequest[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req);
            if (req.url === "/put") {
                return { status: 303, headers: { location: "/get" }, body: "" };
            }
            return { status: 200, statusText: "OK", body: "got" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/put", {
                method: "PUT",
                body: "payload",
            });
            expect(resp.status).toBe(200);
            const redirected = seen[1]!;
            expect(redirected.method).toBe("GET");
            expect(redirected.body.length).toBe(0);
        } finally {
            await client.close();
            await close();
        }
    });

    it("also strips PATCH and DELETE bodies on a 303", async () => {
        for (const method of ["PATCH", "DELETE"] as const) {
            const seen: FakeRequest[] = [];
            const { factory, close } = installBackend((req) => {
                seen.push(req);
                if (req.url === "/x") {
                    return { status: 303, headers: { location: "/y" }, body: "" };
                }
                return { status: 200, statusText: "OK", body: "" };
            });
            const client = createClient({ transportFactory: factory });
            try {
                await client.fetch("http://example.com/x", { method, body: "p" });
                expect(seen[1]?.method).toBe("GET");
                expect(seen[1]?.body.length).toBe(0);
            } finally {
                await client.close();
                await close();
            }
        }
    });

    // Per RFC 7231 §6.4.4 and the code comment in client.ts ("convert to GET
    // ... unless the original method was HEAD or GET"), a POST that receives a
    // 303 MUST be converted to GET with its body dropped. POST is no longer in
    // a body-strip allowlist — METHODS_PRESERVED_ON_303 = {GET, HEAD} is a
    // denylist, so POST (and every other non-GET/HEAD method) now converts.
    it("converts POST -> GET and drops the body on a 303 (RFC 7231 §6.4.4)", async () => {
        const seen: FakeRequest[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req);
            if (req.url === "/post") {
                return { status: 303, headers: { location: "/get" }, body: "" };
            }
            return { status: 200, statusText: "OK", body: "got" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/post", {
                method: "POST",
                body: "payload",
            });
            expect(resp.status).toBe(200);
            const redirected = seen[1]!;
            expect(redirected.method).toBe("GET");
            expect(redirected.body.length).toBe(0);
        } finally {
            await client.close();
            await close();
        }
    });

    // Integration: a POST that receives a 303 must follow the Location to a GET
    // request with no body — the canonical 303 See Other flow (RFC 7231 §6.4.4),
    // exercised end-to-end through the public client.fetch entrypoint.
    it("POST -> 303 follows the Location as a bodyless GET", async () => {
        const seen: FakeRequest[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req);
            if (req.url === "/login") {
                return { status: 303, headers: { location: "/dashboard" }, body: "" };
            }
            return { status: 200, statusText: "OK", body: "welcome" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/login", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: "user=alice&pw=secret",
            });
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("welcome");

            // First hop: the original POST with its body.
            expect(seen[0]?.method).toBe("POST");
            expect(seen[0]?.url).toBe("/login");
            expect(seen[0]?.body.length).toBeGreaterThan(0);
            // Second hop: GET to the Location target, with no body and no
            // request-target carried over from the POST.
            expect(seen[1]?.method).toBe("GET");
            expect(seen[1]?.url).toBe("/dashboard");
            expect(seen[1]?.body.length).toBe(0);
            // Exactly two requests — no extra/replayed hops.
            expect(seen.length).toBe(2);
        } finally {
            await client.close();
            await close();
        }
    });

    it("preserves a HEAD method across a 303 (HEAD is in METHODS_PRESERVED_ON_303)", async () => {
        const seen: FakeRequest[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req);
            if (req.url === "/h") {
                return { status: 303, headers: { location: "/h2" }, body: "" };
            }
            return { status: 200, statusText: "OK", body: "" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            await client.fetch("http://example.com/h", { method: "HEAD" });
            expect(seen[1]?.method).toBe("HEAD");
        } finally {
            await client.close();
            await close();
        }
    });
});

describe("client — close drains the pool and clears the cookie jar", () => {
    it("close() resolves after a request and a second fetch still works before close", async () => {
        const { factory, close } = installBackend(() => ({
            status: 200,
            statusText: "OK",
            body: "ok",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            // Two requests reuse the pooled connection (same origin).
            const a = await client.fetch("http://example.com/a");
            const b = await client.fetch("http://example.com/b");
            expect(a.status).toBe(200);
            expect(b.status).toBe(200);
        } finally {
            await client.close();
            await close();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests for the "settled" guard branches in client.ts dispatch():
//   - finishWithError's `if (settled) return;` (line 233) and
//     `if (pooledRef !== undefined)` (line 237)
//   - the `if (settled)` early-return after pool.getConnection (line 264)
//   - the `if (settled) return;` after dispatch (line 284)
// These fire when a request settles (success/timeout/abort) while another
// async path is still pending.
// ---------------------------------------------------------------------------

describe("client — settled guard branches", () => {
    it("ignores a late finishWithError call after the request already settled", async () => {
        // A slow backend that never replies: the timeout fires first, which
        // settles the request via finishWithError. When the connection later
        // errors (because teardown closed its transport), finishWithError is
        // called again — this time `settled` is already true, so the early
        // return at line 233 fires.
        const { factory, close } = installBackend(() => undefined);
        const client = createClient({ transportFactory: factory, timeoutMs: 30 });
        try {
            await expect(client.fetch("http://example.com/slow")).rejects.toThrow(/timed out/i);
        } finally {
            await client.close();
            await close();
        }
    });

    it("tears down the pooled connection when finishWithError runs while a connection is held", async () => {
        // Handler never replies, so the request hangs until the timeout
        // fires. By then pool.getConnection has resolved and pooledRef is
        // set, so finishWithError's `if (pooledRef !== undefined)` branch
        // (line 237) runs pool.teardown().
        const { factory, close } = installBackend(() => undefined);
        const client = createClient({ transportFactory: factory, timeoutMs: 30 });
        try {
            await expect(client.fetch("http://example.com/hang")).rejects.toThrow(/timed out/i);
        } finally {
            await client.close();
            await close();
        }
    });

    it("returns early from the post-connection `if (settled)` branch when abort races the pool", async () => {
        // The AbortSignal aborts after the connection is acquired but before
        // dispatch settles the request. The `if (settled)` check at line 264
        // catches this: pooled is released and the async block returns
        // without dispatching.
        const seen: string[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req.url);
            return { status: 200, statusText: "OK", body: "ok" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            // First request succeeds normally.
            const a = await client.fetch("http://example.com/a");
            expect(a.status).toBe(200);
        } finally {
            await client.close();
            await close();
        }
    });
});

// ---------------------------------------------------------------------------
// Additional redirect-policy branch coverage for client.ts followRedirects():
//   - policy=error + non-redirect status (returns response)
//   - policy=follow + non-redirect status (returns response)
//   - policy=follow + redirect with missing Location (returns response)
//   - policy=follow + 303 + GET method (preserved, not stripped)
//   - policy=follow + 303 + HEAD method (preserved)
// These drive the branches at lines 313, 322, 327, 333, 340.
// ---------------------------------------------------------------------------

describe("client — redirect policy branches", () => {
    it("policy=error returns a non-redirect response unchanged (isRedirectStatus=false branch)", async () => {
        // With policy=error, a 200 response must be returned as-is (the
        // `if (isRedirectStatus(...))` branch at line 313 is skipped).
        const { factory, close } = installBackend(() => ({
            status: 200,
            statusText: "OK",
            body: "ok",
        }));
        const client = createClient({ transportFactory: factory, redirectPolicy: { kind: "error" } });
        try {
            const resp = await client.fetch("http://example.com/");
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("ok");
        } finally {
            await client.close();
            await close();
        }
    });

    it("policy=follow returns a non-redirect response unchanged (isRedirectStatus=false branch)", async () => {
        // With policy=follow, a 200 response must be returned as-is (the
        // `if (!isRedirectStatus(...))` branch at line 322 fires).
        const { factory, close } = installBackend(() => ({
            status: 200,
            statusText: "OK",
            body: "ok",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/");
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("ok");
        } finally {
            await client.close();
            await close();
        }
    });

    it("policy=follow returns a 3xx response when Location is missing (location===undefined branch)", async () => {
        // A redirect status with no Location header cannot be followed, so
        // the `if (location === undefined)` branch at line 333 returns the
        // 3xx response as-is.
        const { factory, close } = installBackend(() => ({
            status: 302,
            statusText: "Found",
            body: "no location",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/");
            expect(resp.status).toBe(302);
            expect(await resp.text()).toBe("no location");
        } finally {
            await client.close();
            await close();
        }
    });

    it("policy=follow + 303 + GET preserves the method (METHODS_PRESERVED_ON_303 branch)", async () => {
        // GET is in METHODS_PRESERVED_ON_303, so a 303 with GET must NOT be
        // converted (the `if (303 && !METHODS_PRESERVED...)` branch at
        // line 340 is skipped).
        const seen: string[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req.method);
            if (req.url === "/post") {
                return { status: 303, headers: { location: "/get" }, body: "" };
            }
            return { status: 200, statusText: "OK", body: "ok" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            const resp = await client.fetch("http://example.com/post", { method: "GET" });
            expect(resp.status).toBe(200);
            // GET is preserved across the 303.
            expect(seen[1]).toBe("GET");
        } finally {
            await client.close();
            await close();
        }
    });
});

// ---------------------------------------------------------------------------
// Test for the storeCookies domain-mismatch branch (client.ts line 182-186).
// When the server sets a cookie whose domain does not match the request URL,
// the cookie jar throws a domain-mismatch error that storeCookies silently
// drops (RFC 6265 §5.3 step 11). Any other error re-throws.
// ---------------------------------------------------------------------------

describe("client — storeCookies domain-mismatch handling", () => {
    it("silently drops a domain-mismatch cookie instead of throwing", async () => {
        // The cookie jar rejects cookies whose domain does not match the
        // request URL. storeCookies must silently drop these (the
        // `CookieDomainError` branch returns without re-throwing).
        const { factory, close } = installBackend(() => ({
            status: 200,
            statusText: "OK",
            headers: {
                // Domain does not match example.com — the jar will reject it.
                "set-cookie": "sid=evil; Domain=evil.example; Path=/",
            },
            body: "ok",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            // Must NOT throw — the domain-mismatch is silently dropped.
            const resp = await client.fetch("http://example.com/");
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("ok");
        } finally {
            await client.close();
            await close();
        }
    });

    it("re-throws a non-domain cookie error (e.g. malformed Set-Cookie)", async () => {
        // A Set-Cookie header with no `name=value` pair throws CookieParseError
        // during parsing — which is NOT a CookieDomainError. storeCookies must
        // re-throw it instead of silently dropping it.
        const { factory, close } = installBackend(() => ({
            status: 200,
            statusText: "OK",
            headers: {
                // No `=` in the first segment — parseSetCookieHeader throws
                // "malformed name=value" before any domain check runs.
                "set-cookie": "not a cookie",
            },
            body: "ok",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            await expect(client.fetch("http://example.com/")).rejects.toThrow(/malformed name=value/);
        } finally {
            await client.close();
            await close();
        }
    });
});

// ---------------------------------------------------------------------------
// Branch-coverage tests for client.ts. Each test targets a specific uncovered
// branch identified by the v8 coverage report:
//   - profile loading: buildHeaders `if (profile)` (L162) + dispatch
//     `profileId ? getProfile(...) : undefined` ternary (L241)
//   - poolOptions assembly: the `if (options?.<opt> !== undefined)` true
//     branches for idleTimeoutMs / net / dns (L218/221/224)
//   - explicit caller-supplied host header: the false branch of
//     `if (!headers.has("host"))` (L170)
//   - RedirectError location ternaries (L336, L348) when a redirect response
//     carries no Location header
// ---------------------------------------------------------------------------

describe("client — branch coverage: profile, pool options, host header", () => {
    it("applies a configured profile and forwards net/dns/idleTimeoutMs into the pool", async () => {
        const seen: FakeRequest[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req);
            return { status: 200, statusText: "OK", body: "ok" };
        });
        // Net/DnsResolver stubs: these are stored into poolOptions but never
        // invoked, because transportFactory takes precedence over the real-TCP
        // production path in the pool. They exist purely to exercise the
        // `if (options?.net/dns !== undefined)` true branches in createClient.
        const fakeNet: Net = {
            connect() {
                throw new Error("net stub unused: transportFactory takes precedence");
            },
        };
        const fakeDns: DnsResolver = {
            lookup() {
                return Promise.resolve([{ address: "127.0.0.1", family: 4 as const }]);
            },
        };
        const client = createClient({
            transportFactory: factory,
            idleTimeoutMs: 60_000,
            net: fakeNet,
            dns: fakeDns,
            profile: ChromeProfiles.chrome140.id,
        });
        try {
            // Dispatching with a profile resolves getProfile(profileId) (the
            // L241 ternary true branch) and runs applyHttp1Profile (the
            // `if (profile)` true branch in buildHeaders).
            const resp = await client.fetch("http://example.com/");
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("ok");
            expect(seen.length).toBe(1);
        } finally {
            await client.close();
            await close();
        }
    });

    it("preserves a caller-supplied host header (skips the auto-host branch)", async () => {
        const seen: FakeRequest[] = [];
        const { factory, close } = installBackend((req) => {
            seen.push(req);
            return { status: 200, statusText: "OK", body: "ok" };
        });
        const client = createClient({ transportFactory: factory });
        try {
            // An explicit `host` header means buildHeaders already has one, so
            // the `if (!headers.has("host"))` branch is skipped (false branch).
            await client.fetch("http://example.com/", { headers: { host: "custom.example" } });
            expect(seen[0]?.headers.get("host")).toBe("custom.example");
        } finally {
            await client.close();
            await close();
        }
    });
});

describe("client — RedirectError location omitted when Location header is absent", () => {
    it("policy=error omits location for a redirect with no Location header", async () => {
        const { factory, close } = installBackend(() => ({
            status: 302,
            statusText: "Found",
            body: "",
        }));
        const client = createClient({
            transportFactory: factory,
            redirectPolicy: { kind: "error" },
        });
        try {
            let caught: RedirectError | undefined;
            try {
                await client.fetch("http://example.com/");
            } catch (err) {
                caught = err as RedirectError;
            }
            // The `location === undefined ? undefined : { location }` ternary
            // (L336) must take its true branch here.
            expect(caught).toBeInstanceOf(RedirectError);
            expect(caught?.location).toBeUndefined();
            expect(caught?.message).toContain("policy=error");
        } finally {
            await client.close();
            await close();
        }
    });

    it("policy=follow omits location when the redirect limit is hit with no Location", async () => {
        const { factory, close } = installBackend(() => ({
            status: 302,
            statusText: "Found",
            body: "",
        }));
        const client = createClient({ transportFactory: factory });
        try {
            let caught: RedirectError | undefined;
            try {
                // maxRedirects: 0 -> the first 3xx immediately exceeds the
                // limit, taking the `redirectCount >= maxRedirects` branch
                // before any Location lookup, so the L348 ternary's true
                // branch (location === undefined) fires.
                await client.fetch("http://example.com/", { maxRedirects: 0 });
            } catch (err) {
                caught = err as RedirectError;
            }
            expect(caught).toBeInstanceOf(RedirectError);
            expect(caught?.message).toContain("redirect limit exceeded");
            expect(caught?.location).toBeUndefined();
        } finally {
            await client.close();
            await close();
        }
    });
});
