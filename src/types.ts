/**
 * Domain types for @network/fetch.
 *
 * The top-level developer-facing API. This package composes every lower-level
 * package (transport, tls, http1, http2, profiles, cookies) into a unified
 * fetch() surface with browser-accurate TLS + HTTP fingerprints.
 */

import type { CookieJar } from "@network/cookies";
import type { ProfileId } from "@network/profiles";

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
    /** Abort signal — cancels the request when triggered. */
    readonly signal?: AbortSignal;
    /** HTTP/2 stream priority hint (ignored over HTTP/1.1). */
    readonly priority?: number;
}

/** A decoded Fetch response. Body can be consumed once. */
export interface FetchResponse {
    /** Final URL after redirects. */
    readonly url: string;
    /** HTTP status code (e.g. 200). */
    readonly status: number;
    /** HTTP status text (e.g. "OK"). */
    readonly statusText: string;
    /** Response headers (lowercased names). */
    readonly headers: Readonly<Record<string, string>>;
    /** Whether the body has been consumed. */
    readonly bodyUsed: boolean;

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
