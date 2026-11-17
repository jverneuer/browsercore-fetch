/**
 * Minimal typed connection fakes for pool tests — the {@link PooledConnection}
 * values pool tests inject through the mocked dispatch seam.
 *
 * The pool only ever calls `close()` on a pooled conn (drain / eviction /
 * teardown); `request` is unreachable through the pool and throws loudly
 * rather than silently hanging, so a test that accidentally drives it fails
 * for the right reason.
 */

import type {
    Http1Connection,
    Http1ConnectionId,
    Http1ConnectionState,
    HttpResponse,
} from "@browsercore/http1";
import type {
    Http2Connection,
    Http2ConnectionId,
    Http2Response,
} from "@browsercore/http2";
import type { PooledConnection } from "../../src/dispatch.js";

/** Callback fired when the fake connection is closed. */
export type OnFakeClose = () => Promise<void> | void;

/** Build a minimal {@link Http1Connection} whose close() delegates to `onClose`. */
export function fakeHttp1Conn(id: string, onClose: OnFakeClose = () => {}): Http1Connection {
    return {
        id: id as Http1ConnectionId,
        state: { state: "idle" } as Http1ConnectionState,
        async request(): Promise<HttpResponse> {
            throw new Error(`fake http1 conn ${id}: request() is not supported by this fake`);
        },
        async close(): Promise<void> {
            await onClose();
        },
    };
}

/** Build a minimal {@link Http2Connection} whose close() delegates to `onClose`. */
export function fakeHttp2Conn(id: string, onClose: OnFakeClose = () => {}): Http2Connection {
    return {
        id: id as Http2ConnectionId,
        settings: {},
        async request(): Promise<Http2Response> {
            throw new Error(`fake http2 conn ${id}: request() is not supported by this fake`);
        },
        async goaway(): Promise<void> {},
        async ping(): Promise<bigint> {
            return 0n;
        },
        async close(): Promise<void> {
            await onClose();
        },
    };
}

/** Build an http/1.1 {@link PooledConnection} around {@link fakeHttp1Conn}. */
export function pooledHttp1(id: string, onClose?: OnFakeClose): PooledConnection {
    return { protocol: "http1", id: id as Http1ConnectionId, conn: fakeHttp1Conn(id, onClose) };
}

/** Build an http/2 {@link PooledConnection} around {@link fakeHttp2Conn}. */
export function pooledHttp2(id: string, onClose?: OnFakeClose): PooledConnection {
    return { protocol: "http2", id, conn: fakeHttp2Conn(id, onClose) };
}
