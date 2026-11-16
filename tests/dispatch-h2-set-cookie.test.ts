/**
 * Wire-level multi-value Set-Cookie fidelity on the http2 path.
 *
 * Drives the REAL HPACK decode path: a fake HTTP/2 server encodes a HEADERS
 * block carrying TWO separate `set-cookie` literals (RFC 9113 §8.2.3 forbids
 * joining them), the http2 connection decodes it into its `DecodedHeaders`
 * container, and dispatchHttp2 threads that container into the FetchResponse.
 * This is the http2#57 half of the fidelity chain, end to end in wire bytes.
 */
import { describe, expect, it } from "vitest";
import { crypto } from "@browsercore/crypto";
import { connectHttp2 } from "@browsercore/http2";
import { dispatchHttp2 } from "../src/dispatch.js";
import { parseUrl } from "../src/url.js";
import { stubEvents } from "./helpers/test-platform.js";
import { FakeHttp2Server, H2FakeTransport } from "./h2-server.js";

const events = stubEvents();

describe("dispatchHttp2 — multi-value Set-Cookie from the h2 wire", () => {
    it("returns both set-cookie literals verbatim in wire order (HEADERS block with duplicates)", async () => {
        const COMMA_DATE = "Expires=Wed, 13 Jan 2027 07:28:00 GMT";
        const { client, server } = H2FakeTransport.pair();
        new FakeHttp2Server(server, () => ({
            status: 200,
            setCookie: [
                "sid=abc; Path=/; HttpOnly",
                `theme=dark; ${COMMA_DATE}; Path=/`,
            ],
            body: "ok",
        }));
        const conn = await connectHttp2({ transport: client, crypto, events });
        try {
            const resp = await dispatchHttp2(
                conn,
                parseUrl("https://example.com/h2"),
                "GET",
                new Map(),
                undefined,
                undefined,
            );
            expect(resp.getSetCookie()).toEqual([
                "sid=abc; Path=/; HttpOnly",
                `theme=dark; ${COMMA_DATE}; Path=/`,
            ]);
            // Companion generic accessor on the same threaded container.
            expect(resp.getHeaderValues("set-cookie")).toEqual([
                "sid=abc; Path=/; HttpOnly",
                `theme=dark; ${COMMA_DATE}; Path=/`,
            ]);
            // Flat record stays last-wins (RFC 9113 §8.2.3 compat projection).
            expect(resp.headers["set-cookie"]).toBe(`theme=dark; ${COMMA_DATE}; Path=/`);
        } finally {
            await conn.close();
        }
    });

    it("returns an empty array when the h2 response carries no set-cookie", async () => {
        const { client, server } = H2FakeTransport.pair();
        new FakeHttp2Server(server, () => ({
            status: 200,
            headers: { "content-type": "text/plain" },
            body: "ok",
        }));
        const conn = await connectHttp2({ transport: client, crypto, events });
        try {
            const resp = await dispatchHttp2(
                conn,
                parseUrl("https://example.com/h2"),
                "GET",
                new Map(),
                undefined,
                undefined,
            );
            expect(resp.getSetCookie()).toEqual([]);
            expect(resp.getHeaderValues("set-cookie")).toEqual([]);
        } finally {
            await conn.close();
        }
    });
});
