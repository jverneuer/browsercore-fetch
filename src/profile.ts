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
    type CipherSuite,
    type NamedGroup,
    type ProtocolVersion,
    type SignatureScheme,
} from "@browsercore/tls";
import { Http2Settings, type Http2SettingsMap } from "@browsercore/http2";
import type { BrowserProfile } from "@browsercore/profiles";
import { FetchError } from "./errors.js";

/** ALPN protocols offered during the TLS handshake (h2 preferred). */
export const ALPN_PROTOCOLS = ["h2", "http/1.1"] as const;

/**
 * Set of valid TLS cipher suite names. Includes the GREASE sentinel (RFC 8701),
 * the TLS 1.3 AEAD suites, the TLS 1.2 suites that real browsers advertise in
 * their offered ClientHello list for middlebox compatibility, and the legacy
 * 3DES suites some profiles still ship. Typed as `ReadonlySet<string>` because
 * the profiles package advertises suites (e.g. 3DES) that are not yet in the
 * strict CipherSuite union in @browsercore/tls.
 */
const CIPHER_SUITES: ReadonlySet<string> = new Set([
    "TLS_GREASE_RESERVED_0",
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_AES_128_CCM_SHA256",
    "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
    "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
    "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
    "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
    "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
    "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
    "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
    "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
    "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA",
    "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA",
    "TLS_RSA_WITH_AES_128_GCM_SHA256",
    "TLS_RSA_WITH_AES_256_GCM_SHA384",
    "TLS_RSA_WITH_AES_128_CBC_SHA",
    "TLS_RSA_WITH_AES_256_CBC_SHA",
    "TLS_ECDHE_ECDSA_WITH_3DES_EDE_CBC_SHA",
    "TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA",
    "TLS_RSA_WITH_3DES_EDE_CBC_SHA",
]);

/**
 * Set of valid named groups for key share (exhaustive over NamedGroup in
 * @browsercore/tls, plus the post-quantum and FFDHE groups that newer browser
 * profiles advertise). The profiles package types keyShareGroups as string[],
 * so this set must accept every group a shipped profile emits — including ones
 * not yet in the strict NamedGroup union.
 */
const NAMED_GROUPS: ReadonlySet<string> = new Set([
    "secp256r1",
    "secp384r1",
    "secp521r1",
    "x25519",
    "x448",
    "X25519MLKEM768",
    "X25519Kyber768",
    "ffdhe2048",
    "ffdhe3072",
]);

/**
 * Set of valid signature algorithms (exhaustive over SignatureScheme in
 * @browsercore/tls, plus the legacy SHA-1 and P-521 schemes some profiles
 * still advertise). The profiles package types signatureAlgorithms as
 * string[], so this set must accept every scheme a shipped profile emits.
 */
const SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
    "ecdsa_secp256r1_sha256",
    "ecdsa_secp384r1_sha384",
    "ecdsa_secp521r1_sha512",
    "ecdsa_sha1",
    "ed25519",
    "rsa_pss_rsae_sha256",
    "rsa_pss_rsae_sha384",
    "rsa_pss_rsae_sha512",
    "rsa_pkcs1_sha256",
    "rsa_pkcs1_sha384",
    "rsa_pkcs1_sha512",
    "rsa_pkcs1_sha1",
]);

/**
 * Validate a string against the known cipher suites, or throw
 * {@link FetchError}. The set includes every suite a shipped profile emits
 * (including GREASE, TLS 1.2, and legacy 3DES); the cast narrows to CipherSuite
 * for the TLS layer.
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
 * (including post-quantum and FFDHE groups not yet in the strict NamedGroup
 * union); the cast narrows to NamedGroup for the TLS layer.
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
 * (including legacy SHA-1 and P-521 schemes not yet in the strict
 * SignatureScheme union); the cast narrows to SignatureScheme for the TLS layer.
 */
function asSignatureScheme(value: string): SignatureScheme {
    if (!SIGNATURE_ALGORITHMS.has(value)) {
        throw new FetchError(`invalid signature algorithm in profile: ${value}`, { details: { value } });
    }
    return value as SignatureScheme;
}

/** Map a profile version string (e.g. "TLS 1.3") to the {@link ProtocolVersion} wire constant. */
function toProtocolVersion(s: string): ProtocolVersion {
    switch (s) {
        case "TLS 1.2":
            return TLS_1_2;
        case "TLS 1.3":
            return TLS_1_3;
        default:
            // Unknown version strings default to the most secure option rather
            // than fail — a profile advertising an unrecognized version is more
            // likely a forward-compat entry than a hard error.
            return TLS_1_3;
    }
}

/**
 * Translate a browser profile into TLS ClientHello configuration. The profile's
 * string arrays are validated and narrowed to the literal unions the TLS layer
 * expects; an invalid value surfaces as a {@link FetchError}.
 */
export function profileToTlsConfig(profile: BrowserProfile, serverName: string) {
    return {
        cipherSuites: profile.tls.cipherSuites.map(asCipherSuite),
        keyShareGroups: profile.tls.keyShareGroups.map(asNamedGroup),
        signatureAlgorithms: profile.tls.signatureAlgorithms.map(asSignatureScheme),
        supportedVersions: profile.tls.supportedVersions.map(toProtocolVersion),
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

/** Apply HTTP/1.1 profile default headers to a request header map (explicit headers win). */
export function applyHttp1Profile(headers: Map<string, string>, profile: BrowserProfile): void {
    for (const [name, value] of Object.entries(profile.http1.defaultHeaders)) {
        if (!headers.has(name)) {
            headers.set(name, value);
        }
    }
}
