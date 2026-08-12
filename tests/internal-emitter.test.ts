import { describe, expect, it, vi } from "vitest";
import { InternalEventEmitter } from "../src/internal-emitter.js";

describe("InternalEventEmitter", () => {
    it("invokes an `on` listener on emit and returns true", () => {
        const bus = new InternalEventEmitter();
        const spy = vi.fn();
        bus.on("data", spy);
        const result = bus.emit("data", 1, 2);
        expect(result).toBe(true);
        expect(spy).toHaveBeenCalledWith(1, 2);
    });

    it("returns false when emitting an event with no listeners", () => {
        const bus = new InternalEventEmitter();
        expect(bus.emit("nothing")).toBe(false);
    });

    it("supports multiple listeners on the same event", () => {
        const bus = new InternalEventEmitter();
        const spyA = vi.fn();
        const spyB = vi.fn();
        bus.on("evt", spyA);
        bus.on("evt", spyB);
        bus.emit("evt");
        expect(spyA).toHaveBeenCalledTimes(1);
        expect(spyB).toHaveBeenCalledTimes(1);
    });

    it("invokes a `once` listener only once then removes it", () => {
        const bus = new InternalEventEmitter();
        const spy = vi.fn();
        bus.once("boom", spy);
        expect(bus.listenerCount("boom")).toBe(1);
        bus.emit("boom", "x");
        bus.emit("boom", "x");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(bus.listenerCount("boom")).toBe(0);
    });

    it("removes a `once` listener by original reference before it fires", () => {
        const bus = new InternalEventEmitter();
        const spy = vi.fn();
        bus.once("evt", spy);
        bus.off("evt", spy);
        bus.emit("evt");
        expect(spy).not.toHaveBeenCalled();
    });

    it("removes an `on` listener via off", () => {
        const bus = new InternalEventEmitter();
        const spy = vi.fn();
        bus.on("evt", spy);
        bus.off("evt", spy);
        bus.emit("evt");
        expect(spy).not.toHaveBeenCalled();
    });

    it("off is a no-op when the event has no listeners", () => {
        const bus = new InternalEventEmitter();
        expect(() => bus.off("nope", () => {})).not.toThrow();
    });

    it("removeListener is an alias for off", () => {
        const bus = new InternalEventEmitter();
        const spy = vi.fn();
        bus.on("evt", spy);
        bus.removeListener("evt", spy);
        expect(bus.listenerCount("evt")).toBe(0);
    });

    it("listenerCount returns 0 for an unknown event", () => {
        const bus = new InternalEventEmitter();
        expect(bus.listenerCount("unknown")).toBe(0);
    });

    it("removeAllListeners(event) removes only that event", () => {
        const bus = new InternalEventEmitter();
        bus.on("a", () => {});
        bus.on("b", () => {});
        bus.removeAllListeners("a");
        expect(bus.listenerCount("a")).toBe(0);
        expect(bus.listenerCount("b")).toBe(1);
    });

    it("removeAllListeners() with no arg clears every event", () => {
        const bus = new InternalEventEmitter();
        bus.on("a", () => {});
        bus.on("b", () => {});
        bus.removeAllListeners();
        expect(bus.listenerCount("a")).toBe(0);
        expect(bus.listenerCount("b")).toBe(0);
    });

    it("does not revisit a self-removing once listener on subsequent emits", () => {
        const bus = new InternalEventEmitter();
        let calls = 0;
        bus.once("tick", () => {
            calls++;
        });
        bus.emit("tick");
        bus.emit("tick");
        expect(calls).toBe(1);
    });

    it("survives a listener that registers another listener during dispatch", () => {
        const bus = new InternalEventEmitter();
        const later = vi.fn();
        bus.on("go", () => {
            bus.on("go", later);
        });
        bus.emit("go");
        // The newly-added listener is not guaranteed to fire in the same
        // dispatch (snapshot semantics), but it must be registered for later.
        bus.emit("go");
        expect(later).toHaveBeenCalled();
    });
});
