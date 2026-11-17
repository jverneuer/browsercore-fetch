/**
 * Browser-profile translation for @browsercore/fetch.
 *
 * A {@link BrowserProfile} carries fingerprint data as plain strings (IANA
 * names, version strings). The TLS and HTTP/2 layers consume strict literal
 * unions, so this module validates each value at the boundary and narrows it to
 * the protocol layer's expected type — no forcing casts. Invalid values surface
 * as a {@link FetchError} rather than corrupting the handshake.
 */

import {
    TLS_1_2,
    TLS_1_3,
    CIPHER_SUITE_CODES,
    NAMED_GROUP_CODES,
    SIGNATURE_SCHEME_CODES,
    type CipherSuite,
    type NamedGroup,
    type ProtocolVersion,
    type SignatureScheme,
} from "@browsercore/tls";
import { Http2Settings, type Http2SettingsMap, type PriorityFrameSpec } from "@browsercore/http2";
import type { HeaderCasing } from "@browsercore/http1";
import type { BrowserProfile } from "@browsercore/profiles";
import { SUPPORTED_ENCODINGS } from "@browsercore/compression";
import type { CompressionProvider } from "@browsercore/contracts";
import { FetchError } from "./errors.js";

/** RFC 9113 §6.5.2 SETTINGS id order assumed when a profile omits settingsOrder. */
const DEFAULT_SETTINGS_ORDER: readonly number[] = [1, 2, 4, 6];

/**
 * Pseudo-header order assumed when a profile omits it. Chrome's order — no
 * current browser emits the RFC 7540 §8.1.2 example order
 * (`method, scheme, authority, path`), so using it as the default was a
 * fingerprint outlier.
 */
const DEFAULT_PSEUDO_HEADER_ORDER: readonly string[] = ["method", "authority", "scheme", "path"];

/**
 * Browser families whose HTTP/1.1 header field names are Title-Cased on the
 * wire (`Accept`, `User-Agent`, `Sec-CH-UA`). Used to derive a casing default
 * when the profile does not state one explicitly.
 */
const TITLE_CASED_BROWSERS: ReadonlySet<string> = new Set(["chrome", "edge"]);

/** ALPN protocols offered during the TLS handshake (h2 preferred). */
export const ALPN_PROTOCOLS = ["h2", "http/1.1"] as const;

/**
 * Set of valid TLS cipher suite names. Derived from the canonical
 * `CIPHER_SUITE_CODES` table in `@browsercore/profiles` (single source of
 * truth), plus the GREASE sentinel (RFC 8701) which the profiles package
 * does not include in the codes table. Typed as `ReadonlySet<string>` because
 * the profiles package types the codes table keys as `string` (no dependency
 * on `@browsercore/tls` by design); the cast in {@link asCipherSuite} narrows
 * to the `CipherSuite` union, which now includes every value this set holds.
 */
const CIPHER_SUITES: ReadonlySet<string> = new Set([
    ...Object.keys(CIPHER_SUITE_CODES),
    "TLS_GREASE_RESERVED_0",
]);

/**
 * Set of valid named groups for key share. Derived from the canonical
 * `NAMED_GROUP_CODES` table in `@browsercore/profiles` — the single source
 * of truth. The profiles package types keyShareGroups as string[], so this
 * set must accept every group a shipped profile emits.
 */
const NAMED_GROUPS: ReadonlySet<string> = new Set(Object.keys(NAMED_GROUP_CODES));

/**
 * Set of valid signature algorithms. Derived from the canonical
 * `SIGNATURE_SCHEME_CODES` table in `@browsercore/profiles` — the single
 * source of truth. The profiles package types signatureAlgorithms as string[],
 * so this set must accept every scheme a shipped profile emits.
 */
const SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set(
    Object.keys(SIGNATURE_SCHEME_CODES),
);

/**
 * Validate a string against the known cipher suites, or throw
 * {@link FetchError}. The set includes every suite a shipped profile emits
 * (including GREASE, TLS 1.2, and legacy 3DES); the cast narrows to the
 * `CipherSuite` union for the TLS layer.
 */
function asCipherSuite(value: string): CipherSuite {
    if (!CIPHER_SUITES.has(value)) {
        throw new FetchError(`invalid cipher suite in profile: ${value}`, { details: { value } });
    }
    return value as CipherSuite;
}

/**
 * Validate a string against the known key-share groups, or throw
 * {@link FetchError}. The set includes every group a shipped profile emits
 * (including post-quantum and FFDHE groups); the cast narrows to the
 * `NamedGroup` union for the TLS layer.
 */
function asNamedGroup(value: string): NamedGroup {
    if (!NAMED_GROUPS.has(value)) {
        throw new FetchError(`invalid key-share group in profile: ${value}`, { details: { value } });
    }
    return value as NamedGroup;
}

/**
 * Validate a string against the known signature algorithms, or throw
 * {@link FetchError}. The set includes every scheme a shipped profile emits
 * (including legacy SHA-1 and P-521 schemes); the cast narrows to the
 * `SignatureScheme` union for the TLS layer.
 */
function asSignatureScheme(value: string): SignatureScheme {
    if (!SIGNATURE_ALGORITHMS.has(value)) {
        throw new FetchError(`invalid signature algorithm in profile: ${value}`, { details: { value } });
    }
    return value as SignatureScheme;
}

// Version strings the TLS layer recognizes. Legacy versions (TLS 1.2/1.1/1.0)
// are advertised by real browsers for middlebox compatibility but are not
// negotiated here — they are silently dropped.
const RECOGNIZED_VERSIONS = new Set(["TLS 1.2", "TLS 1.3", "TLS 1.1", "TLS 1.0"]);

/**
 * Map a profile version string (e.g. "TLS 1.3") to the {@link ProtocolVersion}
 * wire constant. Throws {@link FetchError} for unrecognized strings — an
 * unknown version is a profile bug, not a default to the most secure option.
 */
function toProtocolVersion(s: string): ProtocolVersion | null {
    switch (s) {
        case "TLS 1.2":
            return TLS_1_2;
        case "TLS 1.3":
            return TLS_1_3;
        case "TLS 1.1":
        case "TLS 1.0":
            // Legacy versions — recognized but not negotiated. Return null so
            // the caller can filter them out.
            return null;
        default:
            throw new FetchError(`invalid protocol version in profile: ${s}`, {
                details: { value: s },
            });
    }
}

/**
 * The TLS layer negotiates TLS 1.3 only. Real browser profiles advertise
 * legacy versions (TLS 1.2/1.1/1.0) alongside TLS 1.3 for middlebox
 * compatibility — they always negotiate TLS 1.3 when the server supports it.
 * Silently filter down to TLS 1.3 only. A profile that advertises NO TLS 1.3
 * at all is a real profile/layer mismatch and must surface as a
 * {@link FetchError}.
 */
function validateSupportedVersions(versions: readonly string[]): readonly ProtocolVersion[] {
    // Drop unrecognized strings silently — they are legacy versions, not bugs.
    const recognized = versions.filter((v) => RECOGNIZED_VERSIONS.has(v));
    const mapped = recognized
        .map((v) => toProtocolVersion(v))
        .filter((v): v is ProtocolVersion => v !== null);
    const supported = mapped.filter((v) => v === TLS_1_3);
    if (supported.length === 0) {
        throw new FetchError(
            `profile advertises no TLS 1.3 version (TLS layer negotiates TLS 1.3 only)`,
            { details: { unsupported: mapped.map((v) => v.wire) } },
        );
    }
    return supported;
}

/**
 * Translate a browser profile into TLS ClientHello configuration. The profile's
 * string arrays are validated and narrowed to the literal unions the TLS layer
 * expects; an invalid value surfaces as a {@link FetchError}. Version and
 * extension filtering apply client-side policy (TLS 1.3 only, no ECH) before
 * the config reaches the wire.
 *
 * `keyShareAdvertisedGroups` (profiles 0.2.4+) is forwarded as
 * `supportedGroups` when present: real Chrome advertises secp256r1+secp384r1
 * in supported_groups while sharing only X25519MLKEM768+x25519 in key_share —
 * omitting the superset made the JA3 curve segment diverge from real Chrome.
 * Absent → field omitted → the TLS layer derives supported_groups from the
 * key-share groups (pre-0.2.4 behavior, backwards compatible).
 */
export function profileToTlsConfig(profile: BrowserProfile, serverName: string) {
    return {
        cipherSuites: profile.tls.cipherSuites.map(asCipherSuite),
        keyShareGroups: profile.tls.keyShareGroups.map(asNamedGroup),
        ...(profile.tls.keyShareAdvertisedGroups === undefined
            ? {}
            : {
                  supportedGroups: profile.tls.keyShareAdvertisedGroups.map(asNamedGroup),
              }),
        signatureAlgorithms: profile.tls.signatureAlgorithms.map(asSignatureScheme),
        supportedVersions: validateSupportedVersions(profile.tls.supportedVersions),
        extensionOrder: profile.tls.extensionOrder,
        grease: profile.tls.grease,
        serverName,
        alpnProtocols: ALPN_PROTOCOLS,
    };
}

/**
 * Translate a profile's named HTTP/2 settings into the numeric
 * {@link Http2SettingsMap} the wire layer expects. The profile uses the
 * human-readable {@link Http2Settings} names; the connection sends the RFC 9113
 * numeric identifiers. `enablePush` is a boolean in the profile but a 0/1 value
 * on the wire, so we coerce it here.
 */
export function profileHttp2Settings(profile: BrowserProfile): Http2SettingsMap {
    const named = profile.http2.settings;
    const wire: Http2SettingsMap = {};
    if (named.headerTableSize !== undefined) {
        wire[Http2Settings.HEADER_TABLE_SIZE] = named.headerTableSize;
    }
    if (named.enablePush !== undefined) {
        // ENABLE_PUSH (RFC 9113 §6.5.2) accepts only 0 or 1.
        wire[Http2Settings.ENABLE_PUSH] = named.enablePush ? 1 : 0;
    }
    if (named.maxConcurrentStreams !== undefined) {
        wire[Http2Settings.MAX_CONCURRENT_STREAMS] = named.maxConcurrentStreams;
    }
    if (named.initialWindowSize !== undefined) {
        wire[Http2Settings.INITIAL_WINDOW_SIZE] = named.initialWindowSize;
    }
    if (named.maxFrameSize !== undefined) {
        wire[Http2Settings.MAX_FRAME_SIZE] = named.maxFrameSize;
    }
    if (named.maxHeaderListSize !== undefined) {
        wire[Http2Settings.MAX_HEADER_LIST_SIZE] = named.maxHeaderListSize;
    }
    return wire;
}

/**
 * HTTP/2 settings are seeded into the connection preface at connect time via
 * the `initialSettings` option (see {@link establishConnection}), so the peer
 * observes our advertised limits from the start. There is no post-connect
 * mutation: the {@link Http2Connection} interface types `settings` as readonly,
 * and pushing an updated SETTINGS frame would require a new interface method
 * that does not yet exist. Settings therefore cannot be changed once the
 * connection is established.
 */

/**
 * Full HTTP/2 connection configuration translated from a browser profile:
 * the SETTINGS values PLUS the impersonation vectors (SETTINGS serialization
 * order, GREASE, connection WINDOW_UPDATE, pseudo-header order, preface
 * PRIORITY frames). Each impersonation field defaults to an RFC/safe value
 * when the profile omits it.
 */
export interface ProfileHttp2Config {
    /** Resolved SETTINGS id → value map (seeded into the connection preface). */
    readonly settings: Http2SettingsMap;
    /** On-wire serialization order of SETTINGS ids (fingerprint signal). */
    readonly settingsOrder: readonly number[];
    /** Prepend a GREASE setting id first in the preface SETTINGS frame. */
    readonly grease: boolean;
    /**
     * Connection-level WINDOW_UPDATE increment sent after the preface
     * SETTINGS. `undefined` → NO frame at all. Never `0`: RFC 9113 §6.9 makes
     * a zero increment on the connection window a connection error of type
     * PROTOCOL_ERROR — real h2 servers GOAWAY the connection on the spot
     * (observed as the #79 GOAWAY against example.com).
     */
    readonly connectionWindowUpdate: number | undefined;
    /** Order of pseudo-headers in request HEADERS frames. */
    readonly pseudoHeaderOrder: readonly string[];
    /** PRIORITY frames sent during the connection preface (dependency tree). */
    readonly priorityFrames: readonly PriorityFrameSpec[];
}

/**
 * Translate a browser profile into the full {@link ProfileHttp2Config} the
 * HTTP/2 wire layer consumes. The SETTINGS map comes from
 * {@link profileHttp2Settings}; every impersonation vector is read defensively
 * from the profile (absent → undefined → RFC/browser default).
 */
export function profileHttp2Config(profile: BrowserProfile): ProfileHttp2Config {
    // Impersonation fields are now declared on Http2Profile directly. Each
    // is optional; absent → RFC/browser default. connectionWindowUpdate is
    // the one field where "absent" must stay undefined (no frame): coercing
    // it to 0 made the http2 layer emit a zero-increment connection
    // WINDOW_UPDATE, which peers treat as a PROTOCOL_ERROR connection error
    // (RFC 9113 §6.9) — the #79 GOAWAY.
    return {
        settings: profileHttp2Settings(profile),
        settingsOrder: profile.http2.settingsOrder ?? DEFAULT_SETTINGS_ORDER,
        grease: profile.http2.grease ?? false,
        connectionWindowUpdate: profile.http2.connectionWindowUpdate,
        pseudoHeaderOrder: profile.http2.pseudoHeaderOrder ?? DEFAULT_PSEUDO_HEADER_ORDER,
        priorityFrames: [],
    };
}

/**
 * HTTP/1.1 wire configuration translated from a browser profile: the header
 * casing mode real browsers apply to field names, plus the profile's default
 * header values and serialization order.
 */
export interface ProfileHttp1Config {
    /** How header field names are cased on the HTTP/1.1 wire. */
    readonly headerCasing: HeaderCasing;
    /** Default headers sent on every request, in profile order. */
    readonly defaultHeaders: Readonly<Record<string, string>>;
    /** Order in which headers are serialized (client-enforced). */
    readonly headerOrder: readonly string[];
}

/**
 * Translate a browser profile into {@link ProfileHttp1Config}.
 *
 * Chromium-based browsers (Chrome, Edge) emit Title-Cased header names
 * (`Accept`, `User-Agent`, `Sec-CH-UA`) over HTTP/1.1; the default for other
 * profiles is lowercase (RFC 7230 §3.2 convention).
 */
export function profileHttp1Config(profile: BrowserProfile): ProfileHttp1Config {
    // Chromium-based browsers (Chrome, Edge) emit Title-Cased header names
    // (`Accept`, `User-Agent`, `Sec-CH-UA`) over HTTP/1.1; the default for
    // other profiles is lowercase (RFC 7230 §3.2 convention).
    const headerCasing =
        TITLE_CASED_BROWSERS.has(profile.name.toLowerCase()) ? "title" : "lowercase";
    return {
        headerCasing,
        defaultHeaders: profile.http1.defaultHeaders,
        headerOrder: profile.http1.headerOrder,
    };
}

/**
 * Apply HTTP/1.1 profile default header VALUES to a request header map
 * (explicit headers win). Header-name CASING is not applied here — the map
 * stores lowercased names and the http1 serializer re-cases them at wire time
 * according to the {@link ProfileHttp1Config.headerCasing} threaded through
 * {@link dispatchHttp1}. Keeping value-application and casing separate means
 * each is a single decision testable in isolation.
 */
export function applyHttp1Profile(headers: Map<string, string>, profile: BrowserProfile): void {
    for (const [name, value] of Object.entries(profile.http1.defaultHeaders)) {
        if (!headers.has(name)) {
            headers.set(name, value);
        }
    }
}

/**
 * The optional `http2DefaultHeaders` contract field being added to
 * `BrowserProfile` in @browsercore/profiles 0.2.4 (e.g. chrome:
 * `{"priority":"u=0, i"}`, firefox: `te`/`priority`). Declared locally here via
 * structural typing so fetch compiles against both the published 0.2.x line
 * (field absent → every reader below is a no-op) and >= 0.2.4 (field present →
 * merged as defaults). No runtime dependency on unpublished code; delete this
 * interface once profiles ^0.2.4 is the minimum and ships the field itself.
 */
export interface BrowserProfileH2Defaults {
    /** Default regular headers the browser sends on every HTTP/2 request. */
    readonly http2DefaultHeaders?: Readonly<Record<string, string>>;
}

/**
 * Read {@link BrowserProfileH2Defaults.http2DefaultHeaders} defensively.
 * Profiles < 0.2.4 do not carry the field; the assertion is sound because the
 * added member is optional, so every existing profile object already satisfies
 * the widened type.
 */
export function profileHttp2DefaultHeaders(
    profile: BrowserProfile,
): Readonly<Record<string, string>> {
    const withH2Defaults = profile as BrowserProfile & BrowserProfileH2Defaults;
    return withH2Defaults.http2DefaultHeaders ?? {};
}

/**
 * Apply the profile's h2 default headers as request-header defaults (explicit
 * headers win). Applied in the shared header-assembly path, so both wire
 * protocols see them — headers are assembled BEFORE the pooled connection (and
 * thus the ALPN result) exists, and browsers send `priority` on both h1 and h2
 * anyway. No-op when the installed profiles version lacks the field.
 */
export function applyHttp2DefaultHeaders(headers: Map<string, string>, profile: BrowserProfile): void {
    for (const [name, value] of Object.entries(profileHttp2DefaultHeaders(profile))) {
        if (!headers.has(name)) {
            headers.set(name, value);
        }
    }
}

/**
 * Encoding tokens safe to advertise in `accept-encoding`: everything the
 * compression provider can decode, minus `identity` (browsers never list it).
 * Single source of truth: the literal set @browsercore/compression can decode.
 */
const ADVERTISABLE_ENCODINGS: ReadonlySet<string> = new Set(
    SUPPORTED_ENCODINGS.filter((encoding) => encoding !== "identity"),
);

/**
 * Compute the profile's default `accept-encoding` value: the browser-true list
 * from `http1.acceptEncoding` intersected with the encodings this platform can
 * actually decode. Advertising an encoding the injected provider cannot
 * decompress (e.g. `zstd` before the provider learns it) would make compressed
 * responses undecodable, so unsupported tokens are dropped. Any q-parameters
 * on a kept token are preserved verbatim; token order (a fingerprint signal)
 * is preserved.
 */
export function profileAcceptEncoding(profile: BrowserProfile): string {
    const decodableTokens = profile.http1.acceptEncoding
        .split(",")
        .map((segment) => segment.trim())
        .filter((segment) => {
            const encodingName = (segment.split(";")[0] ?? "").trim().toLowerCase();
            return ADVERTISABLE_ENCODINGS.has(encodingName);
        });
    return decodableTokens.join(", ");
}

/**
 * Apply {@link profileAcceptEncoding} as the `accept-encoding` default when a
 * compression provider is injected and no value is already set. Without a
 * provider we advertise nothing — we cannot decode what we would be asking
 * for — and let the server respond with an identity body.
 */
export function applyAcceptEncodingDefault(
    headers: Map<string, string>,
    profile: BrowserProfile,
    compression: CompressionProvider | undefined,
): void {
    if (compression === undefined || headers.has("accept-encoding")) {
        return;
    }
    const value = profileAcceptEncoding(profile);
    if (value !== "") {
        headers.set("accept-encoding", value);
    }
}
