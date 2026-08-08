/**
 * Response building + body decoding for @browsercore/fetch.
 *
 * Owns the bridge from a decoded HTTP response (status, headers, raw bytes) to
 * the public {@link FetchResponse} shape: header-map projection, content-encoding
 * decompression, and the once-consumable body with `clone()`.
 */

import type { CompressionProvider, ContentEncoding } from "@browsercore/contracts";
import type { HttpBodyKind } from "@browsercore/http1";
import { FetchError } from "./errors.js";
import type { FetchResponse } from "./types.js";

/** Read all values for a (case-insensitive) header name from a response header map. */
function readHeaderValues(headers: ReadonlyMap<string, string>, name: string): string[] {
    const out: string[] = [];
    for (const [key, value] of headers) {
        if (key.toLowerCase() === name) {
            out.push(value);
        }
    }
    return out;
}

/** Read a `Set-Cookie` header (or multiple) from a response header map. */
export function readSetCookie(headers: ReadonlyMap<string, string>): string[] {
    return readHeaderValues(headers, "set-cookie");
}

/** Read the `content-encoding` header (case-insensitive) from a response header map. */
export function readContentEncoding(headers: ReadonlyMap<string, string>): ContentEncoding | undefined {
    for (const [name, value] of headers) {
        if (name.toLowerCase() === "content-encoding") {
            return value as ContentEncoding;
        }
    }
    return undefined;
}

/**
 * Decompress a body if `content-encoding` is set; otherwise return as-is.
 *
 * `compression` is the platform-provided decompression surface (e.g.
 * `@browsercore/compression`). Injected so protocol code never binds to
 * `node:zlib` directly. No-op when no encoding; throws if an encoding is set
 * but no provider was injected.
 */
export function decompressBody(
    compression: CompressionProvider | undefined,
    body: Uint8Array,
    encoding: ContentEncoding | undefined,
): Uint8Array {
    if (encoding === undefined) {
        return body;
    }
    if (compression === undefined) {
        throw new FetchError(
            "decompressBody requires a compression provider for encoded responses. " +
                "Pass compression via FetchClientOptions or provide a Platform.",
        );
    }
    return compression.decompress(body, encoding);
}

/** Translate a fetch body (bytes/string/absent) into the wire `HttpBodyKind`. */
export function bodyKind(body: Uint8Array | string | undefined): HttpBodyKind {
    if (body === undefined) {
        return { kind: "empty" };
    }
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return { kind: "bytes", data: bytes };
}

/** Build a {@link FetchResponse} from a decoded HTTP response. */
export function buildResponse(
    url: string,
    statusCode: number,
    statusText: string,
    headers: ReadonlyMap<string, string>,
    rawBody: Uint8Array,
    encoding: ContentEncoding | undefined,
    compression: CompressionProvider | undefined,
): FetchResponse {
    const headerRecord: Record<string, string> = {};
    for (const [name, value] of headers) {
        headerRecord[name] = value;
    }
    const body = decompressBody(compression, rawBody, encoding);

    // The body can be consumed once. `clone()` re-derives a fresh response so
    // the caller can re-read after the first consumption.
    let consumed = false;
    const snapshot = body;

    function consume(): Promise<Uint8Array> {
        if (consumed) {
            return Promise.reject(new FetchError("body already consumed", { url }));
        }
        consumed = true;
        return Promise.resolve(snapshot);
    }

    return {
        url,
        status: statusCode,
        statusText,
        headers: headerRecord,
        get bodyUsed(): boolean {
            return consumed;
        },
        body: consume,
        async json(): Promise<unknown> {
            const bytes = await consume();
            const text = new TextDecoder().decode(bytes);
            return JSON.parse(text) as unknown;
        },
        async text(): Promise<string> {
            const bytes = await consume();
            return new TextDecoder().decode(bytes);
        },
        clone(): FetchResponse {
            // A clone re-derives from the original bytes with its own
            // `consumed` flag, so each copy can be read independently.
            return buildResponse(url, statusCode, statusText, headers, rawBody, encoding, compression);
        },
    };
}
