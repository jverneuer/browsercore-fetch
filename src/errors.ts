/**
 * Typed errors for @browsercore/fetch.
 *
 * Errors are part of the API — every failure mode is an explicit type so callers
 * can match on `kind` instead of parsing messages. Lower-level errors (TLS,
 * transport) are wrapped via `cause`.
 *
 * Mirrors the @browsercore/transport error pattern: a base class carrying
 * `kind`/`details`/`cause`, a subclass per failure domain, and an
 * `ensureFetchError` wrapper for narrowing caught values.
 */

import type { FetchRequestId } from "./types.js";

/** Arbitrary structured detail carried alongside a fetch error message. */
export type FetchErrorDetails = Record<string, unknown>;

/** Base class for every fetch error. */
export class FetchError extends Error {
    public readonly kind = "FetchError" as const;
    public readonly details: FetchErrorDetails;
    /** The request id (when available) for correlation. */
    public readonly requestId: FetchRequestId | undefined;
    /** The URL the request targeted (when available). */
    public readonly url: string | undefined;
    /** `Error | undefined` (not `?`) so assignment is valid under exactOptionalPropertyTypes. */
    public override readonly cause: Error | undefined;

    constructor(
        message: string,
        options?: {
            requestId?: FetchRequestId;
            url?: string;
            details?: FetchErrorDetails;
            cause?: Error;
        },
    ) {
        super(message, options?.cause ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        this.requestId = options?.requestId;
        this.url = options?.url;
        this.details = options?.details ?? {};
        this.cause = options?.cause;
    }
}

/** The request exceeded the configured timeout before completing. */
export class FetchTimeoutError extends Error {
    public readonly kind = "FetchTimeoutError" as const;
    public readonly timeoutMs: number;
    public override readonly cause: Error | undefined;

    constructor(timeoutMs: number, options?: { cause?: Error }) {
        super(`Request timed out after ${timeoutMs}ms`, options);
        this.name = "FetchTimeoutError";
        this.timeoutMs = timeoutMs;
        this.cause = options?.cause;
    }
}

/** A redirect loop or redirect-limit violation was detected. */
export class RedirectError extends Error {
    public readonly kind = "RedirectError" as const;
    public readonly location: string | undefined;
    public readonly redirectCount: number;
    public override readonly cause: Error | undefined;

    constructor(
        message: string,
        options?: {
            location?: string;
            redirectCount?: number;
            cause?: Error;
        },
    ) {
        super(message, options?.cause ? { cause: options.cause } : undefined);
        this.name = "RedirectError";
        this.location = options?.location;
        this.redirectCount = options?.redirectCount ?? 0;
        this.cause = options?.cause;
    }
}

/** ALPN negotiation failed or the server rejected the offered protocols. */
export class ProtocolError extends Error {
    public readonly kind = "ProtocolError" as const;
    /** Protocols offered via ALPN, e.g. ["h2", "http/1.1"]. */
    public readonly offeredProtocols: ReadonlyArray<string>;
    /** Protocol the server selected (if any). */
    public readonly selectedProtocol: string | undefined;
    public override readonly cause: Error | undefined;

    constructor(
        message: string,
        options?: {
            offeredProtocols?: ReadonlyArray<string>;
            selectedProtocol?: string;
            cause?: Error;
        },
    ) {
        super(message, options?.cause ? { cause: options.cause } : undefined);
        this.name = "ProtocolError";
        this.offeredProtocols = options?.offeredProtocols ?? [];
        this.selectedProtocol = options?.selectedProtocol;
        this.cause = options?.cause;
    }
}

/** The request was aborted via an AbortSignal before it could complete. */
export class AbortError extends FetchError {
    constructor(message: string, options?: { url?: string; requestId?: FetchRequestId }) {
        super(message, { ...options, details: { reason: "aborted" } });
        this.name = "AbortError";
    }
}

/**
 * Narrow a caught value to a typed {@link FetchError}, or wrap it as one.
 *
 * Use at the boundary where an unknown rejection must be surfaced to the
 * caller: `catch (e) { throw ensureFetchError(e, { url }) }`. A value already
 * typed is returned unchanged; anything else is wrapped with `cause`.
 */
export function ensureFetchError(
    e: unknown,
    options?: { url?: string; requestId?: FetchRequestId },
): FetchError {
    if (e instanceof FetchError) {
        return e;
    }
    if (e instanceof Error) {
        return new FetchError(e.message, { ...options, cause: e });
    }
    return new FetchError(typeof e === "string" ? e : "unknown fetch error", options);
}
