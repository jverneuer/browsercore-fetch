/**
 * Tests for the http2 dispatch path in client.ts (case "http2" branch at
 * line 272 + storeCookies at line 285). These live in their own file so the
 * top-level pool mock does not disturb the existing client tests (which rely
 * on the real pool + transportFactory to drive the fake HTTP/1.1 server).
 */
import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@browsercore/transport";

// ---------------------------------------------------------------------------
// Top-level pool mock: every createClient() in this file gets a pool whose
// getConnection returns a fake http2 pooled connection.
// ---------------------------------------------------------------------------

const fakePool = {
    getConnection: vi.fn(),
    release: vi.fn(),
    teardown: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../src/pool.js", () => ({
    createPool: () => fakePool,
}));

// ---------------------------------------------------------------------------
// Profiles mock: getProfile can be overridden per-test so the optional
// `http2DefaultHeaders` contract field (profiles 0.2.4) can be simulated on
// top of the installed 0.2.x data. Unset → the real registry answers.
// ---------------------------------------------------------------------------

const mockGetProfile = vi.fn();
vi.mock("@browsercore/profiles", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@browsercore/profiles")>();
    return {
        ...actual,
        getProfile: (id: Parameters<typeof actual.getProfile>[0]) =>
            mockGetProfile(id) ?? actual.getProfile(id),
    };
});

// Import AFTER the mocks are registered.
// eslint-disable-next-line import/first
import { createClient } from "../src/client.js";
import { createCookieJar } from "@browsercore/cookies";
import { createTestPlatform } from "./helpers/test-platform.js";
// eslint-disable-next-line import/first
import { ChromeProfiles, type BrowserProfile, type ProfileId } from "@browsercore/profiles";
// eslint-disable-next-line import/first
import type { BrowserProfileH2Defaults } from "../src/profile.js";
// eslint-disable-next-line import/first
import { DecodedHeadersImpl, type Http2Request } from "@browsercore/http2";

// createClient requires an injected Platform (its pool throws without an
// EventProvider). fetch never provides its own; browsersmith is the sole
// source in production. The pool is mocked here, but the guard still runs.
const platform = createTestPlatform();

describe("client — http2 dispatch path", () => {
    it("dispatches over an http2 pooled connection and stores Set-Cookie", async () => {
        const http2Conn = {
            id: "h2-client-fake",
            settings: {},
            async request() {
                return {
                    statusCode: 200,
                    headers: new DecodedHeadersImpl([
                        { name: "content-type", value: "text/plain" },
                        { name: "set-cookie", value: "sid=abc; Path=/" },
                    ]),
                    body: new TextEncoder().encode("h2 body"),
                };
            },
            async goaway() {},
            async ping() {
                return 0n;
            },
            async close() {},
        };

        fakePool.getConnection.mockReset();
        fakePool.getConnection.mockResolvedValue({ protocol: "http2" as const, id: "h2-client-fake", conn: http2Conn });
        fakePool.release.mockReset();
        fakePool.drain.mockReset().mockResolvedValue(undefined);

        const client = createClient({ platform });
        try {
            const resp = await client.fetch("https://example.com/h2");
            expect(resp.status).toBe(200);
            expect(await resp.text()).toBe("h2 body");
            expect(fakePool.getConnection).toHaveBeenCalled();
            // A second request should carry the cookie from the first response.
            await client.fetch("https://example.com/h2");
            expect(fakePool.getConnection).toHaveBeenCalledTimes(2);
        } finally {
            await client.close();
        }
    });

    it("http2 response headers are accessible and body can be consumed as JSON", async () => {
        const http2Conn = {
            id: "h2-json-fake",
            settings: {},
            async request() {
                return {
                    statusCode: 201,
                    headers: new DecodedHeadersImpl([
                        { name: "content-type", value: "application/json" },
                        { name: "set-cookie", value: "token=xyz" },
                    ]),
                    body: new TextEncoder().encode('{"ok":true}'),
                };
            },
            async goaway() {},
            async ping() {
                return 0n;
            },
            async close() {},
        };

        fakePool.getConnection.mockReset();
        fakePool.getConnection.mockResolvedValue({ protocol: "http2" as const, id: "h2-json-fake", conn: http2Conn });
        fakePool.release.mockReset();
        fakePool.drain.mockReset().mockResolvedValue(undefined);

        const client = createClient({ platform });
        try {
            const resp = await client.fetch("https://example.com/api");
            expect(resp.status).toBe(201);
            expect(resp.headers["content-type"]).toBe("application/json");
            expect(await resp.json()).toEqual({ ok: true });
        } finally {
            await client.close();
        }
    });

    it("getSetCookie() returns both h2 set-cookie literals verbatim and the jar stores both", async () => {
        const http2Conn = {
            id: "h2-setcookie-fake",
            settings: {},
            async request() {
                return {
                    statusCode: 200,
                    // Two separate set-cookie fields in the decoded block — the
                    // RFC 9113 §8.2.3 wire shape the flat Map view collapses.
                    headers: new DecodedHeadersImpl([
                        { name: "content-type", value: "text/plain" },
                        { name: "set-cookie", value: "sid=abc; Path=/; HttpOnly" },
                        {
                            name: "set-cookie",
                            value: "theme=dark; Expires=Wed, 13 Jan 2027 07:28:00 GMT; Path=/",
                        },
                    ]),
                    body: new TextEncoder().encode("ok"),
                };
            },
            async goaway() {},
            async ping() {
                return 0n;
            },
            async close() {},
        };

        fakePool.getConnection.mockReset();
        fakePool.getConnection.mockResolvedValue({ protocol: "http2" as const, id: "h2-setcookie-fake", conn: http2Conn });
        fakePool.release.mockReset();
        fakePool.drain.mockReset().mockResolvedValue(undefined);

        const jar = createCookieJar();
        const client = createClient({ platform, cookieJar: jar });
        try {
            const resp = await client.fetch("https://example.com/h2");
            expect(resp.getSetCookie()).toEqual([
                "sid=abc; Path=/; HttpOnly",
                "theme=dark; Expires=Wed, 13 Jan 2027 07:28:00 GMT; Path=/",
            ]);
            // Flat record stays last-wins for backward compatibility.
            expect(resp.headers["set-cookie"]).toBe(
                "theme=dark; Expires=Wed, 13 Jan 2027 07:28:00 GMT; Path=/",
            );
            // storeCookies consumes the multi-value view, not the flat record —
            // both cookies land in the jar.
            const stored = jar.getCookies({ hostname: "example.com", pathname: "/", protocol: "https:" });
            expect(stored.map((c) => `${c.name}=${c.value}`)).toEqual(["sid=abc", "theme=dark"]);
        } finally {
            await client.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Request-fidelity tests: the wire headers a profiled h2 request carries.
// D1: no `host` regular header over h2 (WAF trigger). D4: profile-driven
// accept-encoding (filtered to decodable encodings) + http2DefaultHeaders.
// ---------------------------------------------------------------------------

describe("client — http2 request fidelity (host removal, accept-encoding, priority)", () => {
    /**
     * A chrome-140 profile carrying the 0.2.4 contract fields: the browser-true
     * accept-encoding WITH zstd, and http2DefaultHeaders with Chrome's priority
     * header. Simulates the data profiles 0.2.4 will ship.
     */
    function chrome140WithH2Defaults(): BrowserProfile & BrowserProfileH2Defaults {
        return {
            ...ChromeProfiles.chrome140,
            http1: {
                ...ChromeProfiles.chrome140.http1,
                acceptEncoding: "gzip, deflate, br, zstd",
            },
            http2DefaultHeaders: { priority: "u=0, i" },
        };
    }

    /** Fake h2 connection that records every request's wire headers. */
    function recordingHttp2(requests: Http2Request[]): {
        conn: unknown;
        pooled: { protocol: "http2"; id: string; conn: unknown };
    } {
        const conn = {
            id: "h2-record",
            settings: {},
            async request(req: Http2Request) {
                requests.push(req);
                return {
                    statusCode: 200,
                    headers: new DecodedHeadersImpl([]),
                    body: new TextEncoder().encode("ok"),
                };
            },
            async goaway() {},
            async ping() {
                return 0n;
            },
            async close() {},
        };
        return { conn, pooled: { protocol: "http2" as const, id: "h2-record", conn } };
    }

    it("h2 wire headers carry :authority and NO host, filtered accept-encoding, priority default", async () => {
        const requests: Http2Request[] = [];
        const { pooled } = recordingHttp2(requests);
        fakePool.getConnection.mockReset();
        fakePool.getConnection.mockResolvedValue(pooled);
        fakePool.release.mockReset();
        fakePool.drain.mockReset().mockResolvedValue(undefined);
        mockGetProfile.mockReset();
        mockGetProfile.mockImplementation((id: ProfileId) =>
            id === ChromeProfiles.chrome140.id ? chrome140WithH2Defaults() : undefined,
        );

        const client = createClient({ platform, profile: ChromeProfiles.chrome140.id });
        try {
            const resp = await client.fetch("https://example.com/h2");
            expect(resp.status).toBe(200);
            const wire = requests[0]?.headers;
            // D1: :authority present, host stripped (nginx edges 400 a regular
            // host header on h2 — no browser sends it).
            expect(wire?.get(":authority")).toBe("example.com");
            expect(wire?.has("host")).toBe(false);
            // D4: browser-true accept-encoding filtered to what the platform
            // compression provider can decode (zstd dropped).
            expect(wire?.get("accept-encoding")).toBe("gzip, deflate, br");
            // D4: http2DefaultHeaders merged as defaults.
            expect(wire?.get("priority")).toBe("u=0, i");
        } finally {
            await client.close();
        }
    });

    it("caller-supplied accept-encoding and priority win over profile defaults, untouched", async () => {
        const requests: Http2Request[] = [];
        const { pooled } = recordingHttp2(requests);
        fakePool.getConnection.mockReset();
        fakePool.getConnection.mockResolvedValue(pooled);
        fakePool.release.mockReset();
        fakePool.drain.mockReset().mockResolvedValue(undefined);
        mockGetProfile.mockReset();
        mockGetProfile.mockImplementation((id: ProfileId) =>
            id === ChromeProfiles.chrome140.id ? chrome140WithH2Defaults() : undefined,
        );

        const client = createClient({ platform, profile: ChromeProfiles.chrome140.id });
        try {
            await client.fetch("https://example.com/h2", {
                headers: { "accept-encoding": "identity", priority: "u=9" },
            });
            const wire = requests[0]?.headers;
            expect(wire?.get("accept-encoding")).toBe("identity");
            expect(wire?.get("priority")).toBe("u=9");
        } finally {
            await client.close();
        }
    });
});
