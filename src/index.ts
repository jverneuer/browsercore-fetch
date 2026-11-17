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
    FetchProxyError,
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

// The option-shape types FetchOptions/FetchClientOptions speak in, re-exported
// from their CANONICAL home (@browsercore/contracts — audit #3): consumers
// configure `proxy`/`profile`/`clock` without depending on the sibling
// implementation packages. @browsercore/proxy and @browsercore/profiles
// re-export these same canonical types, so existing imports keep compiling.
export type { Clock, ProfileId, ProxyConfig, ProxyScheme, TimerHandle } from "@browsercore/contracts";
export { systemClock } from "./types.js";

export { assertNever } from "./utils.js";

import { createClient, type FetchClientOptions } from "./client.js";
import type { Platform } from "@browsercore/contracts";
import type { FetchOptions, FetchResponse } from "./types.js";

/**
 * Top-level convenience `fetch` — creates a client from the same options a
 * {@link createClient} call would receive, issues the request, and closes the
 * client. The client is constructed IDENTICALLY to
 * `createClient(options + platform).fetch(input, options)`: every
 * FetchClientOptions-compatible key of `options` (profile, cookieJar,
 * timeoutMs, proxy) plus `platform` becomes a client default, so both entry
 * points produce byte-identical wire output for identical options (#79).
 * Use {@link createClient} for connection reuse.
 *
 * @example
 * ```ts
 * const response = await fetch("https://example.com", { profile: "chrome-140" }, platform);
 * console.log(response.status, await response.text());
 * ```
 */
export function fetch(input: string, options?: FetchOptions, platform?: Platform): Promise<FetchResponse> {
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
    if (options?.proxy !== undefined) {
        // Forwarded so pool keys + dial decisions resolve identically to the
        // createClient path — the per-request copy below lands on the same
        // value either way, but the constructed client must not diverge.
        defaults.proxy = options.proxy;
    }
    if (platform !== undefined) {
        defaults.platform = platform;
    }
    const client = createClient(defaults);
    return client.fetch(input, options).finally(() => {
        void client.close();
    });
}
