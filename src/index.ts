/**
 * @browsercore/fetch — public API surface.
 *
 * The developer-facing HTTP API. Composes transport, tls, http1, http2,
 * profiles, and cookies. Most consumers should use the top-level `fetch()`
 * convenience; create a {@link FetchClient} for connection reuse or defaults.
 */

export { createClient } from "./client.js";
export type { FetchClient, FetchClientOptions } from "./client.js";

export {
    FetchError,
    FetchTimeoutError,
    ProtocolError,
    RedirectError,
} from "./errors.js";

export type {
    FetchMethod,
    FetchOptions,
    FetchRequestId,
    FetchResponse,
    ParsedUrl,
    RedirectPolicy,
} from "./types.js";

export { assertNever } from "./utils.js";

import { createClient, type FetchClientOptions } from "./client.js";
import type { FetchOptions, FetchResponse } from "./types.js";

/**
 * Top-level convenience `fetch` — creates a default client, issues the request,
 * and closes the client. Use {@link createClient} for connection reuse.
 *
 * @example
 * ```ts
 * const response = await fetch("https://example.com", { profile: "chrome-140" });
 * console.log(response.status, await response.text());
 * ```
 */
export function fetch(input: string, options?: FetchOptions): Promise<FetchResponse> {
    // Only assign defaults that are actually present. Under
    // exactOptionalPropertyTypes, `cookieJar?: CookieJar` does not accept an
    // explicit `undefined`, so spreading absent keys keeps the object valid.
    const defaults: { -readonly [K in keyof FetchClientOptions]?: FetchClientOptions[K] } = {};
    if (options?.profile !== undefined) {
        defaults.profile = options.profile;
    }
    if (options?.cookieJar !== undefined) {
        defaults.cookieJar = options.cookieJar;
    }
    if (options?.timeoutMs !== undefined) {
        defaults.timeoutMs = options.timeoutMs;
    }
    const client = createClient(defaults);
    return client.fetch(input, options).finally(() => {
        void client.close();
    });
}
