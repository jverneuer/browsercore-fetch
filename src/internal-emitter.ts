/**
 * Minimal runtime-independent internal event emitter.
 *
 * Implements the {@link EventProvider} surface (on / once / off / emit / etc.)
 * using a plain `Map` so this package can own a **private** event bus without
 * depending on `node:events`. The TLS transport adapter uses it so that
 * close/error forwarded from the TLS connection land on the adapter's own bus
 * and are observed only by HTTP-layer listeners — never re-broadcast to the
 * shared injected bus (which caused an event-forwarding loop).
 *
 * Semantics mirror the subset of `node:events.EventEmitter` that the adapter
 * relies on: `once` listeners self-remove after their first dispatch, and
 * `off` / `removeListener` remove a `once`-wrapped listener by its *original*
 * reference (matching Node's behaviour).
 */

/** A listener function stored against an event name. */
interface StoredListener {
    /** The function invoked on dispatch (a wrapper for `once` registrations). */
    call: (...args: unknown[]) => void;
    /** The original listener passed by the caller (for `off` matching). */
    readonly original: (...args: unknown[]) => void;
}

/**
 * A tiny event bus implementing the {@link EventProvider} contract with no
 * runtime dependencies beyond the standard library.
 */
export class InternalEventEmitter {
    private readonly events = new Map<string, Set<StoredListener>>();

    public on(event: string, listener: (...args: unknown[]) => void): void {
        this.getOrCreate(event).add({ call: listener, original: listener });
    }

    public once(event: string, listener: (...args: unknown[]) => void): void {
        const set = this.getOrCreate(event);
        const record: StoredListener = {
            original: listener,
            // `record` is captured by reference in the closure; it is fully
            // initialised before `call` is ever invoked (on the next dispatch).
            call: (...args: unknown[]): void => {
                set.delete(record);
                listener(...args);
            },
        };
        set.add(record);
    }

    public off(event: string, listener: (...args: unknown[]) => void): void {
        const set = this.events.get(event);
        if (set === undefined) {
            return;
        }
        for (const entry of set) {
            if (entry.original === listener) {
                set.delete(entry);
                return;
            }
        }
    }

    public removeListener(event: string, listener: (...args: unknown[]) => void): void {
        this.off(event, listener);
    }

    public emit(event: string, ...args: unknown[]): boolean {
        const set = this.events.get(event);
        if (set === undefined || set.size === 0) {
            return false;
        }
        // Snapshot to a fresh array so listeners that add/remove entries
        // (including self-removing `once` wrappers) during dispatch do not
        // mutate the set under iteration.
        for (const entry of Array.from(set)) {
            entry.call(...args);
        }
        return true;
    }

    public listenerCount(event: string): number {
        return this.events.get(event)?.size ?? 0;
    }

    public removeAllListeners(event?: string): void {
        if (event === undefined) {
            this.events.clear();
        } else {
            this.events.delete(event);
        }
    }

    private getOrCreate(event: string): Set<StoredListener> {
        let set = this.events.get(event);
        if (set === undefined) {
            set = new Set();
            this.events.set(event, set);
        }
        return set;
    }
}
