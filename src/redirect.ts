/**
 * Redirect policy + status helpers for @browsercore/fetch.
 *
 * Owns the redirect-triggering status code set and the resolution of the
 * effective redirect policy from per-request options + client defaults. The
 * status membership check uses a `Set<number>` so it never widens the literal
 * status-code tuple (the old code cast the tuple to `readonly number[]` to
 * satisfy `Array.includes`, which dodged the type system).
 */

import type { RedirectPolicy } from "./types.js";

/** HTTP status codes that trigger redirect handling. */
export const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308] as const;

/** Redirect status code union — exhaustive over {@link REDIRECT_STATUS_CODES}. */
export type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];

/**
 * Membership set for {@link isRedirectStatus}. Built from the literal tuple so
 * the two can never drift; typed as `Set<number>` so `has(number)` needs no cast.
 */
const REDIRECT_STATUS_SET: ReadonlySet<number> = new Set(REDIRECT_STATUS_CODES);

/** Methods whose body must be stripped on a 303 redirect. */
export const BODY_STRIP_ON_303 = new Set(["PUT", "PATCH", "DELETE"]);

/** Whether `status` is one of the redirect-triggering status codes. */
export function isRedirectStatus(status: number): status is RedirectStatusCode {
    return REDIRECT_STATUS_SET.has(status);
}

/** Resolve the effective redirect policy from options + client defaults. */
export function resolveRedirectPolicy(
    options: { readonly followRedirects?: boolean; readonly maxRedirects?: number } | undefined,
    defaults: RedirectPolicy | undefined,
): RedirectPolicy {
    if (options?.followRedirects === false) {
        return { kind: "manual" };
    }
    if (defaults) {
        return defaults;
    }
    return { kind: "follow", maxRedirects: options?.maxRedirects ?? 20 };
}
