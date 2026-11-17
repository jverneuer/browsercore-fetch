/**
 * Typed response-header fixture constructors — the terse builders for
 * scripted `HttpResponse.headers` / `Http2Response.headers` values.
 *
 * A plain `Map<string, string>` no longer satisfies those response types
 * (both require the multi-value `getHeaderValues` fidelity view), so every
 * scripted response builds the REAL shipped container:
 * {@link ParsedHeadersImpl} for http/1.1, {@link DecodedHeadersImpl} for
 * http/2. Mirrors the `responseHeaders` tuple helper in @browsercore/http1's
 * own test-helpers (the family precedent).
 */

import { ParsedHeadersImpl } from "@browsercore/http1";
import type { ParsedHeaders } from "@browsercore/http1";
import { DecodedHeadersImpl } from "@browsercore/http2";
import type { DecodedHeaders } from "@browsercore/http2";

/** Build an http/1.1 {@link ParsedHeaders} from ordered wire pairs. */
export function h1Headers(pairs: readonly (readonly [string, string])[]): ParsedHeaders {
    return new ParsedHeadersImpl(pairs.map(([name, value]) => ({ name, value })));
}

/** Build an http/2 {@link DecodedHeaders} from ordered wire pairs. */
export function h2Headers(pairs: readonly (readonly [string, string])[]): DecodedHeaders {
    return new DecodedHeadersImpl(pairs.map(([name, value]) => ({ name, value })));
}
