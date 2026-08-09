/**
 * Test-local {@link CompressionProvider} for @browsercore/fetch tests.
 *
 * @browsercore/compression (0.2.1) exports only types, errors, and utilities —
 * the `compression` singleton was removed. Tests that exercise real
 * content-encoding round-trips (gzip/deflate/brotli decompression) inject
 * their own node:zlib-backed provider here. Production code receives the
 * provider via Platform; never a bare import.
 */

import { brotliCompressSync, brotliDecompressSync, deflateRawSync, deflateSync, gunzipSync, gzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { CompressionProvider, ContentEncoding } from "@browsercore/contracts";

/**
 * Build a node:zlib-backed {@link CompressionProvider} for tests.
 *
 * Mirrors browser tolerance for `deflate` (try zlib-wrapped first, fall back to
 * raw headerless deflate). Unsupported encodings throw so callers surface a
 * clean error rather than garbage bytes.
 *
 * @returns A fresh stateless {@link CompressionProvider}.
 */
export function createTestCompressionProvider(): CompressionProvider {
    return {
        gzip(data: Uint8Array): Uint8Array {
            return new Uint8Array(gzipSync(data));
        },
        gunzip(data: Uint8Array): Uint8Array {
            return new Uint8Array(gunzipSync(data));
        },
        deflate(data: Uint8Array): Uint8Array {
            return new Uint8Array(deflateSync(data));
        },
        inflate(data: Uint8Array): Uint8Array {
            return new Uint8Array(inflateSync(data));
        },
        inflateRaw(data: Uint8Array): Uint8Array {
            return new Uint8Array(inflateRawSync(data));
        },
        brotliCompress(data: Uint8Array): Uint8Array {
            return new Uint8Array(brotliCompressSync(data));
        },
        brotliDecompress(data: Uint8Array): Uint8Array {
            return new Uint8Array(brotliDecompressSync(data));
        },
        decompress(data: Uint8Array, encoding: ContentEncoding): Uint8Array {
            switch (encoding) {
                case "gzip":
                case "x-gzip":
                    return new Uint8Array(gunzipSync(data));
                case "deflate": {
                    // Servers disagree on deflate framing: try zlib-wrapped
                    // first, fall back to raw deflate (browser-compatible).
                    try {
                        return new Uint8Array(inflateSync(data));
                    } catch {
                        return new Uint8Array(inflateRawSync(data));
                    }
                }
                case "br":
                    return new Uint8Array(brotliDecompressSync(data));
                default:
                    throw new Error(`unsupported content-encoding: ${encoding}`);
            }
        },
    };
}

/** Shared test compression provider — stateless, safe to reuse across tests. */
export const compression: CompressionProvider = createTestCompressionProvider();
