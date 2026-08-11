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
    ExtensionType,
    type CipherSuite,
    type NamedGroup,
    type ProtocolVersion,
    type SignatureScheme,
} from "@browsercore/tls";
import { Http2Settings, type Http2SettingsMap, type PriorityFrameSpec } from "@browsercore/http2";
import type { HeaderCasing } from "@browsercore/http1";
import type { BrowserProfile } from "@browsercore/profiles";
import { FetchError } from "./errors.js";

/** RFC 9113 §6.5.2 SETTINGS id order assumed when a profile omits settingsOrder. */
const DEFAULT_SETTINGS_ORDER: readonly number[] = [1, 2, 4, 6];

/** RFC 7540 §8.1.2 pseudo-header order assumed when a profile omits it. */
const DEFAULT_PSEUDO_HEADER_ORDER: readonly string[] = ["method", "scheme", "authority", "path"];

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
 * ECH (encrypted_client_hello, extension 65037) requires HPKE keys the client
 * does not have. An empty-body ECH makes the ClientHello look odd and some
 * servers reject it, so the client filters it out of the profile's
 * extensionOrder before connecting. The TLS layer can still encode an empty
 * placeholder if ECH is ever explicitly requested.
 */
function filterExtensionOrder(extensions: readonly number[]): readonly number[] {
    return extensions.filter((ext) => ext !== ExtensionType.ENCRYPTED_CLIENT_HELLO);
}

/**
 * Translate a browser profile into TLS ClientHello configuration. The profile's
 * string arrays are validated and narrowed to the literal unions the TLS layer
 * expects; an invalid value surfaces as a {@link FetchError}. Version and
 * extension filtering apply client-side policy (TLS 1.3 only, no ECH) before
 * the config reaches the wire.
 */
export function profileToTlsConfig(profile: BrowserProfile, serverName: string) {
    return {
        cipherSuites: profile.tls.cipherSuites.map(asCipherSuite),
        keyShareGroups: profile.tls.keyShareGroups.map(asNamedGroup),
        signatureAlgorithms: profile.tls.signatureAlgorithms.map(asSignatureScheme),
        supportedVersions: validateSupportedVersions(profile.tls.supportedVersions),
        extensionOrder: filterExtensionOrder(profile.tls.extensionOrder),
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
    /** Connection-level WINDOW_UPDATE increment after the preface; 0 = none. */
    readonly connectionWindowUpdate: number;
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
    // is optional; absent → RFC/browser default.
    return {
        settings: profileHttp2Settings(profile),
        settingsOrder: profile.http2.settingsOrder ?? DEFAULT_SETTINGS_ORDER,
        grease: profile.http2.grease ?? false,
        connectionWindowUpdate: profile.http2.connectionWindowUpdate ?? 0,
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
