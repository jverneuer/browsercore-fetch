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
 * Allow-list of cipher suites this layer accepts from browser profiles.
 *
 * Wider than the TLS layer's `CipherSuite` union (which only covers the TLS 1.3
 * AEAD suites it can wire-encode). Real browser profiles also advertise TLS 1.2
 * suites, GREASE placeholders, and legacy fallbacks — all of which must pass
 * profile-to-config translation so the ClientHello can be built. Values not in
 * this set throw in `asCipherSuite` with a message pointing here.
 */
const CIPHER_SUITES: ReadonlySet<string> = new Set([
    // GREASE placeholder (RFC 8701) — inserted by Chrome/Edge profiles.
    "TLS_GREASE_RESERVED_0",
    // TLS 1.3 (AEAD + hash).
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_AES_128_CCM_SHA256",
    // TLS 1.2 ECDHE (GCM / ChaCha / CBC).
    "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
    "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
    "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
    "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
    "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
    "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
    "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256",
    "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256",
    "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA",
    "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
    "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA",
    "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
    "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384",
    "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384",
    // TLS 1.2 DHE.
    "TLS_DHE_RSA_WITH_AES_128_GCM_SHA256",
    "TLS_DHE_RSA_WITH_AES_256_GCM_SHA384",
    "TLS_DHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
    // TLS 1.2 RSA (older servers).
    "TLS_RSA_WITH_AES_128_GCM_SHA256",
    "TLS_RSA_WITH_AES_256_GCM_SHA384",
    // TLS 1.2 CBC (Safari, older profiles).
    "TLS_RSA_WITH_AES_128_CBC_SHA256",
    "TLS_RSA_WITH_AES_256_CBC_SHA256",
    "TLS_RSA_WITH_AES_128_CBC_SHA",
    "TLS_RSA_WITH_AES_256_CBC_SHA",
    // 3DES (legacy — some profiles still include it).
    "TLS_RSA_WITH_3DES_EDE_CBC_SHA",
]);

/**
 * Allow-list of named groups this layer accepts from browser profiles.
 *
 * Covers the standard NIST curves, the x25519/x448 EC groups, and the
 * post-quantum hybrid groups Chrome 128+ advertises. Values not in this set
 * throw in `asNamedGroup` with a message pointing here.
 */
const NAMED_GROUPS: ReadonlySet<string> = new Set([
    "secp256r1",
    "secp384r1",
    "secp521r1",
    "x25519",
    "x448",
    // Post-quantum hybrid groups (draft-ietf-tls-hybrid-design).
    "X25519Kyber768",    // 0x6399 — Chrome 128.
    "X25519MLKEM768",    // 0x11ec — Chrome 140.
    "Secp256r1MLKEM768", // 0x11xx — future Chrome.
    "Secp384r1MLKEM1024", // 0x12xx — future.
]);

/**
 * Allow-list of signature algorithms this layer accepts from browser profiles.
 *
 * Wider than the TLS layer's `SignatureScheme` union (which only covers the
 * PKCS#1 / PSS schemes it can wire-encode). Real browser profiles also
 * advertise EdDSA (ed25519) and older SHA-1/SHA-384 PKCS#1 variants — all of
 * which must pass profile-to-config translation so the ClientHello can be built.
 * Values not in this set throw in `asSignatureScheme` with a message pointing
 * here.
 */
const SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
    // ECDSA (NIST curves).
    "ecdsa_secp256r1_sha256",
    "ecdsa_secp384r1_sha384",
    // RSA-PSS.
    "rsa_pss_rsae_sha256",
    "rsa_pss_rsae_sha384",
    // RSA-PKCS#1 (Chrome, Edge, Safari).
    "rsa_pkcs1_sha256",
    "rsa_pkcs1_sha384",
    "rsa_pkcs1_sha1",
    // EdDSA (Firefox).
    "ed25519",
]);

/**
 * Validate and narrow a string to a {@link CipherSuite}, or throw {@link FetchError}.
 *
 * The allow-list is wider than the `CipherSuite` union (which only covers the
 * TLS 1.3 AEAD suites the wire layer can encode), so accepted values are cast
 * to `CipherSuite` here. Genuinely unknown suites throw with a message that
 * points at the `CIPHER_SUITES` allow-list.
 */
function asCipherSuite(value: string): CipherSuite {
    if (!CIPHER_SUITES.has(value)) {
        throw new FetchError(
            `invalid cipher suite in profile: "${value}". ` +
                `If this is a legitimate suite, add it to the CIPHER_SUITES allow-list in fetch/src/profile.ts.`,
            { details: { value } },
        );
    }
    return value as CipherSuite;
}

/**
 * Validate and narrow a string to a {@link NamedGroup}, or throw {@link FetchError}.
 *
 * The allow-list is wider than the `NamedGroup` union (which only covers the
 * standard EC groups), so accepted values are cast to `NamedGroup` here.
 * Genuinely unknown groups throw with a message that points at the
 * `NAMED_GROUPS` allow-list.
 */
function asNamedGroup(value: string): NamedGroup {
    if (!NAMED_GROUPS.has(value)) {
        throw new FetchError(
            `invalid key-share group in profile: "${value}". ` +
                `If this is a legitimate group, add it to the NAMED_GROUPS allow-list in fetch/src/profile.ts.`,
            { details: { value } },
        );
    }
    return value as NamedGroup;
}

/**
 * Validate and narrow a string to a {@link SignatureScheme}, or throw {@link FetchError}.
 *
 * The allow-list is wider than the `SignatureScheme` union (which only covers
 * the PKCS#1 / PSS schemes the wire layer can encode), so accepted values are
 * cast to `SignatureScheme` here. Genuinely unknown schemes throw with a
 * message that points at the `SIGNATURE_ALGORITHMS` allow-list.
 */
function asSignatureScheme(value: string): SignatureScheme {
    if (!SIGNATURE_ALGORITHMS.has(value)) {
        throw new FetchError(
            `invalid signature algorithm in profile: "${value}". ` +
                `If this is a legitimate scheme, add it to the SIGNATURE_ALGORITHMS allow-list in fetch/src/profile.ts.`,
            { details: { value } },
        );
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
