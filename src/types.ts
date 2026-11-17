/**
 * Domain types for @browsercore/fetch.
 *
 * The top-level developer-facing API. This package composes every lower-level
 * package (transport, tls, http1, http2, profiles, cookies) into a unified
 * fetch() surface with browser-accurate TLS + HTTP fingerprints.
 */

import type { Clock, ProfileId, ProxyConfig, TimerHandle } from "@browsercore/contracts";
// DELIBERATELY still @browsercore/cookies, not contracts: contracts 0.2.7
// also declares a CookieJar, but its `setCookie(url, cookie)` parameter
// order is flipped relative to the jar cookies 0.2.2 actually implements
// (`setCookie(raw, url)`) — the two are NOT interchangeable yet. Cookie
// reconciliation is deferred (architect decision); the drift alarms in
// cookies 0.2.2 guard the seam until that wave lands. Switching this
// import early would type-check against a shape nothing implements.
import type { CookieJar } from "@browsercore/cookies";

/** Branded request identifier for logging / correlation. */
export type FetchRequestId = string & { __brand: "FetchRequestId" };

/** HTTP methods the fetch surface supports. */
export type FetchMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS";

/** How redirects should be followed. Discriminated union — every case explicit. */
export type RedirectPolicy =
    | { readonly kind: "follow"; readonly maxRedirects: number }
    | { readonly kind: "manual" }
    | { readonly kind: "error" };

/** Options for {@link FetchClient.fetch} and the top-level convenience {@link fetch}. */
export interface FetchOptions {
    /** HTTP method. Defaults to GET. */
    readonly method?: FetchMethod;
    /** Request headers (name/value pairs). Case-insensitive on send. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Request body (omit for GET/HEAD). */
    readonly body?: Uint8Array | string;
    /** Browser profile to mimic (TLS + HTTP fingerprint). */
    readonly profile?: ProfileId;
    /** Follow redirects automatically. Defaults to `true`. */
    readonly followRedirects?: boolean;
    /** Maximum redirects before raising {@link RedirectError}. Default 20. */
    readonly maxRedirects?: number;
    /** Request timeout in milliseconds (covers full round-trip). Default 30_000. */
    readonly timeoutMs?: number;
    /** Cookie jar to send cookies from and store Set-Cookie into. */
    readonly cookieJar?: CookieJar;
    /**
     * Tunnel this request through a proxy (HTTP CONNECT or SOCKS5/5h via
     * @browsercore/proxy). A per-request proxy replaces the client-level
     * default; when absent, the client default applies.
     */
    readonly proxy?: ProxyConfig;
    /** Abort signal — cancels the request when triggered. */
    readonly signal?: AbortSignal;
}

/**
 * Structural view of the response-header container a protocol layer hands to
 * fetch. http1's `ParsedHeaders` and http2's `DecodedHeaders` share this exact
 * shape: a flat last-wins `ReadonlyMap` (the backward-compatible view) plus a
 * multi-value reader. {@link FetchResponse} retains the container so the
 * multi-value view survives the projection onto the flat `headers` record.
 */
export interface MultiValueHeaders extends ReadonlyMap<string, string> {
    /**
     * All values for a field, in wire order — each header line's value
     * verbatim as a separate entry, never comma-joined. Empty array when the
     * field is absent. Field name is matched case-insensitively.
     */
    getHeaderValues(name: string): readonly string[];
}

/** A decoded Fetch response. Body can be consumed once. */
export interface FetchResponse {
    /** Final URL after redirects. */
    readonly url: string;
    /** HTTP status code (e.g. 200). */
    readonly status: number;
    /** HTTP status text (e.g. "OK"). */
    readonly statusText: string;
    /** Response headers (lowercased names). Last-wins for repeated fields. */
    readonly headers: Readonly<Record<string, string>>;
    /** Whether the body has been consumed. */
    readonly bodyUsed: boolean;

    /**
     * All values for a response header field of the FINAL response, in wire
     * order — each header line's value verbatim as a separate entry, never
     * comma-joined. Empty array when the field is absent. The field name is
     * matched case-insensitively.
     *
     * The flat {@link headers} record collapses repeated fields (last-wins,
     * kept for backward compatibility); this is the fidelity view that
     * surfaces every value. Repeated fields must not be folded: `Set-Cookie`
     * values routinely contain dates and other commas (RFC 6265bis requires
     * recipients to handle each field individually; RFC 9113 §8.2.3 forbids
     * joining Set-Cookie on h2).
     */
    getHeaderValues(name: string): readonly string[];
    /**
     * Every `Set-Cookie` value of the FINAL response, in wire order,
     * verbatim (never joined — the values contain commas). Empty array when
     * the response carried no `Set-Cookie`. WHATWG semantics: only the final
     * response of a redirect chain is exposed here.
     */
    getSetCookie(): readonly string[];

    /** Consume the body as raw bytes. Rejects if called twice. */
    body(): Promise<Uint8Array>;
    /** Consume the body as a parsed JSON value. */
    json(): Promise<unknown>;
    /** Consume the body as a UTF-8 string. */
    text(): Promise<string>;
    /** Clone the response so the body can be consumed independently. */
    clone(): FetchResponse;
}

/** A parsed and validated URL the client can dispatch against. */
export interface ParsedUrl {
    readonly scheme: "http" | "https";
    readonly host: string;
    readonly port: number;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
}

// ---------------------------------------------------------------------------
// Clock seam (injected — the canonical @browsercore/contracts Clock)
// ---------------------------------------------------------------------------

/**
 * The default {@link Clock}: delegates to the platform globals
 * (`Date.now()`, `performance.now()`, global `setTimeout`/`clearTimeout`).
 *
 * Same seam pattern tls/transport use (`systemClock` housed next to the
 * options that inject it), typed as the CANONICAL contracts Clock
 * (replaceability audit 2026-11-16, remediation item #6: fetch held the
 * Platform yet ignored `platform.time` — its whole-request timeout and pool
 * idle-eviction timers were bare `setTimeout`). Production callers never
 * need to supply a clock; tests inject a manual-advance fake so timeouts
 * fire at exact virtual instants with zero real timers.
 *
 * Unit contract (from the contract's docs): `now()` is WALL time (epoch ms,
 * can jump — NTP); `monotonic()` is elapsed/deadline time in ms and never
 * goes backwards.
 */
export const systemClock: Clock = {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    sleep: (ms) =>
        new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        }),
    setTimeout: (ms, fn) => {
        return setTimeout(fn, ms);
    },
    clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

// Re-exported so consumers can type their own Clock injections (and read the
// handle type) without importing @browsercore/contracts directly — same
// convenience rule transport applies to its clock seam.
export type { Clock, TimerHandle };
