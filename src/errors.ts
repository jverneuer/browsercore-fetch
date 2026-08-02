/**
 * Typed errors for @browsercore/fetch.
 *
 * Fetch-level failures: timeouts, redirect loops, protocol negotiation errors.
 * Lower-level errors (TLS, transport) are wrapped via `cause`.
 */

import type { FetchRequestId } from "./types.js";

/** Base class for every fetch error. */
export class FetchError extends Error {
    public readonly kind = "FetchError" as const;
    /** The request id (when available) for correlation. */
    public readonly requestId: FetchRequestId | undefined;
    /** The URL the request targeted (when available). */
    public readonly url: string | undefined;
    public override readonly cause: Error | undefined;

    constructor(
        message: string,
        options?: {
            requestId?: FetchRequestId;
            url?: string;
            cause?: Error;
        },
    ) {
        super(message, options?.cause ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        this.requestId = options?.requestId;
        this.url = options?.url;
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
