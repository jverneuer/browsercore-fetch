import { describe, expect, it } from "vitest";
import {
    BODY_STRIP_ON_303,
    REDIRECT_STATUS_CODES,
    isRedirectStatus,
    resolveRedirectPolicy,
} from "../src/redirect.js";
import type { RedirectPolicy } from "../src/types.js";

describe("isRedirectStatus", () => {
    it("returns true for each member of REDIRECT_STATUS_CODES", () => {
        for (const code of REDIRECT_STATUS_CODES) {
            expect(isRedirectStatus(code)).toBe(true);
        }
    });

    it("returns false for non-redirect codes", () => {
        for (const code of [200, 201, 204, 304, 400, 404, 500, 0, 100]) {
            expect(isRedirectStatus(code)).toBe(false);
        }
    });

    it("covers every documented redirect code exactly", () => {
        expect([...REDIRECT_STATUS_CODES]).toEqual([301, 302, 303, 307, 308]);
    });
});

describe("BODY_STRIP_ON_303", () => {
    it("strips PUT/PATCH/DELETE bodies on a 303", () => {
        expect(BODY_STRIP_ON_303.has("PUT")).toBe(true);
        expect(BODY_STRIP_ON_303.has("PATCH")).toBe(true);
        expect(BODY_STRIP_ON_303.has("DELETE")).toBe(true);
    });

    it("does not strip GET/HEAD/POST", () => {
        expect(BODY_STRIP_ON_303.has("GET")).toBe(false);
        expect(BODY_STRIP_ON_303.has("HEAD")).toBe(false);
        expect(BODY_STRIP_ON_303.has("POST")).toBe(false);
    });
});

describe("resolveRedirectPolicy", () => {
    it("returns manual when followRedirects:false overrides defaults", () => {
        // Per-request override beats the client default regardless of the
        // default's shape.
        const policy = resolveRedirectPolicy(
            { followRedirects: false },
            { kind: "follow", maxRedirects: 5 },
        );
        expect(policy).toEqual({ kind: "manual" });
    });

    it("returns the client default when it is set and no override present", () => {
        const def: RedirectPolicy = { kind: "error" };
        expect(resolveRedirectPolicy(undefined, def)).toBe(def);
    });

    it("returns the client follow default with its own maxRedirects", () => {
        const def: RedirectPolicy = { kind: "follow", maxRedirects: 3 };
        expect(resolveRedirectPolicy(undefined, def)).toEqual({ kind: "follow", maxRedirects: 3 });
    });

    it("defaults to follow with maxRedirects=20 when nothing is configured", () => {
        expect(resolveRedirectPolicy(undefined, undefined)).toEqual({
            kind: "follow",
            maxRedirects: 20,
        });
    });

    it("honors an explicit maxRedirects per-request when falling back to follow", () => {
        expect(resolveRedirectPolicy({ maxRedirects: 7 }, undefined)).toEqual({
            kind: "follow",
            maxRedirects: 7,
        });
    });

    it("treats followRedirects:true as no-override (falls through to default)", () => {
        // followRedirects must be strictly false to force manual; true is the
        // default so it does not override an explicit client default.
        const def: RedirectPolicy = { kind: "manual" };
        expect(resolveRedirectPolicy({ followRedirects: true }, def)).toBe(def);
    });
});
