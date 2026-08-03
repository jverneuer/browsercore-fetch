import { describe, expect, it } from "vitest";
import { assertNever, createId } from "../src/utils.js";

describe("assertNever", () => {
    it("throws an Error describing the unexpected value", () => {
        // Callers use this in the `default` branch of an exhaustive switch.
        // It must throw at runtime when an unhandled value slips through.
        expect(() => assertNever("rogue" as never)).toThrowError();
        try {
            assertNever("rogue" as never);
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain("rogue");
        }
    });

    it("stringifies the value into the message", () => {
        // Objects are JSON-stringified so the failure is diagnosable.
        expect(() => assertNever({ x: 1 } as never)).toThrow(/"x":1/);
    });
});

describe("createId", () => {
    it("uses the given prefix", () => {
        const id = createId("fetch");
        expect(id.startsWith("fetch_")).toBe(true);
    });

    it("defaults to the 'fetch' prefix", () => {
        expect(createId().startsWith("fetch_")).toBe(true);
    });

    it("produces unique ids across calls", () => {
        const a = createId("x");
        const b = createId("x");
        expect(a).not.toBe(b);
    });

    it("embeds both the timestamp and random components", () => {
        // format: <prefix>_<base36-timestamp>_<base36-random>
        const id = createId("p");
        const parts = id.split("_");
        expect(parts[0]).toBe("p");
        expect(parts).toHaveLength(3);
        expect(parts[1]!.length).toBeGreaterThan(0);
        expect(parts[2]!.length).toBeGreaterThan(0);
    });
});
