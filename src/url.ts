/**
 * URL parsing + projection for @browsercore/fetch.
 *
 * The WHATWG `URL` parser does the heavy lifting (normalization, host/port
 * splitting); we project its result onto the strict {@link ParsedUrl} shape the
 * rest of the client consumes, and reject any scheme that isn't http/https at
 * the boundary so external data is validated immediately.
 */

import type { CookieUrl } from "@browsercore/cookies";
import { FetchError } from "./errors.js";
import type { ParsedUrl } from "./types.js";

/** Branded pool key — host:port is the origin identity for connection reuse. */
export type PoolKey = string & { __brand: "PoolKey" };

/** Build the connection-pool key for a parsed URL (origin identity). */
export function poolKey(url: ParsedUrl): PoolKey {
    return `${url.host}:${url.port}` as PoolKey;
}

/** Pick the default port for a scheme. */
export function defaultPort(scheme: "http" | "https"): number {
    return scheme === "http" ? 80 : 443;
}

/** Narrow a parsed-protocol string to the supported http/https scheme set. */
function asScheme(s: string): "http" | "https" {
    return s === "http" || s === "https" ? s : "https";
}

/** Parse a URL string into a {@link ParsedUrl}. Throws {@link FetchError} on malformed input. */
export function parseUrl(input: string): ParsedUrl {
    // The WHATWG URL parser normalizes the path and splits host/port/scheme.
    // We project the result onto our strict `ParsedUrl` shape and reject any
    // scheme that isn't http/https — external data is validated immediately.
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw cause === undefined
            ? new FetchError(`invalid URL: ${input}`, { url: input })
            : new FetchError(`invalid URL: ${input}`, { url: input, cause });
    }
    const scheme = parsed.protocol.replace(":", "");
    if (scheme !== "http" && scheme !== "https") {
        throw new FetchError(`unsupported scheme: ${scheme}`, { url: input });
    }
    const schemeConst = scheme;
    const host = parsed.hostname;
    const port = parsed.port === "" ? defaultPort(schemeConst) : Number(parsed.port);
    return {
        scheme: schemeConst,
        host,
        port,
        path: parsed.pathname,
        query: parsed.search,
        fragment: parsed.hash,
    };
}

/** Convert a {@link ParsedUrl} back to an origin string (scheme + host + port). */
export function originString(url: ParsedUrl): string {
    const portSuffix = url.port === defaultPort(url.scheme) ? "" : `:${url.port}`;
    return `${url.scheme}://${url.host}${portSuffix}`;
}

/** Build the request target (path + query) for the wire request line. */
export function requestTarget(url: ParsedUrl): string {
    return `${url.path}${url.query}`;
}

/** Resolve a possibly-relative Location against the current URL. */
export function resolveRedirectUrl(current: ParsedUrl, location: string): ParsedUrl {
    // A relative Location is resolved against the current URL via the WHATWG
    // URL parser. Absolute URLs are parsed directly.
    const absolute = new URL(location, originString(current) + current.path + current.query);
    const scheme = asScheme(absolute.protocol.replace(":", ""));
    return {
        scheme,
        host: absolute.hostname,
        port: absolute.port === "" ? defaultPort(scheme) : Number(absolute.port),
        path: absolute.pathname,
        query: absolute.search,
        fragment: absolute.hash,
    };
}

/** Build a {@link CookieUrl} (the cookie-jar matching shape) from a parsed URL. */
export function cookieUrl(url: ParsedUrl): CookieUrl {
    return {
        hostname: url.host,
        pathname: url.path,
        protocol: `${url.scheme}:`,
    };
}
