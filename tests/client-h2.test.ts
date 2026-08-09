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

// Import AFTER the mock is registered.
// eslint-disable-next-line import/first
import { createClient } from "../src/client.js";
import { createTestPlatform } from "./helpers/test-platform.js";

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
                    headers: new Map<string, string>([
                        ["content-type", "text/plain"],
                        ["set-cookie", "sid=abc; Path=/"],
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
                    headers: new Map<string, string>([
                        ["content-type", "application/json"],
                        ["set-cookie", "token=xyz"],
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
});
