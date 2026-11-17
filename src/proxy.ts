/**
 * Proxy plumbing for @browsercore/fetch.
 *
 * Fetch owns no proxy protocol logic — @browsercore/proxy performs the
 * SOCKS5 / HTTP CONNECT handshakes over the injected Platform. This module
 * holds the two things fetch DOES own:
 *
 * - {@link proxyIdentity} — the proxy's contribution to a connection-pool
 *   key. Two requests to the same origin through different proxies (or with
 *   different credentials) must never share a tunneled connection.
 * - {@link proxyDialPlatform} — assembling the minimal Platform the proxy
 *   dialer reads, from the net/dns adapters fetch already resolved.
 */

import type {
    CompressionProvider,
    Crypto,
    DnsResolver,
    EventProvider,
    Net,
    Network,
    Platform,
    ProxyConfig,
    Telemetry,
    Time,
    UdpSocketFactory,
} from "@browsercore/contracts";

/** FNV-1a 64-bit offset basis — deterministic, dependency-free digest. */
const FNV_OFFSET = 0xcbf29ce484222325n;
/** FNV-1a 64-bit prime. */
const FNV_PRIME = 0x100000001b3n;

/**
 * FNV-1a 64-bit digest of `input`, as 16 hex chars.
 *
 * Used only to opaque-encode proxy credentials inside pool keys — it keeps
 * plaintext secrets out of anything that could be logged, and makes distinct
 * credential sets map to distinct keys. It is an encoding, not cryptographic
 * protection: the pool key is never treated as a secret store.
 */
export function fnv1a64Hex(input: string): string {
    let hash = FNV_OFFSET;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= BigInt(input.codePointAt(index) ?? 0);
        hash = BigInt.asUintN(64, hash * FNV_PRIME);
    }
    return hash.toString(16).padStart(16, "0");
}

/**
 * Opaque per-proxy identity for connection-pool keys.
 *
 * Endpoint (scheme/host/port) stays readable for debuggability; credentials
 * are reduced to an {@link fnv1a64Hex} digest so raw secrets never appear in
 * a key (pool keys surface in logs and error paths).
 */
export function proxyIdentity(proxy: ProxyConfig): string {
    const credentials = `${proxy.username ?? ""}\u0000${proxy.password ?? ""}`;
    return `${proxy.scheme}://${proxy.host}:${proxy.port}#${fnv1a64Hex(credentials)}`;
}

/**
 * Assemble the minimal {@link Platform} that `connectViaProxy` dials through.
 *
 * The proxy dialer reads only `network.tcp` (every scheme) and `network.dns`
 * (socks5 with a hostname target). `dns` stays genuinely `undefined` when
 * absent (single cast below) so the dialer raises its own typed error guiding
 * to `socks5h`, instead of a stub masking that path. Every other bundle is
 * untouched by the dialer — each is a throwing getter that names the culprit
 * if that contract ever breaks (the same pattern @browsercore/proxy's own
 * test platform uses to prove it). The throwing `time` getter is deliberate
 * even under fetch 0.2.25's clock seam: the DIALER must not touch time — the
 * CLIENT resolves the Clock once (client.ts) and routes its own timers.
 */
export function proxyDialPlatform(net: Net, dns: DnsResolver | undefined): Platform {
    // The network bundle: tcp is what every proxy scheme dials through; dns
    // may be genuinely absent (`dns as never` preserves "absent" through the
    // non-optional local Network view) so the dialer raises its typed error
    // instead of a stub masking the missing-resolver path. udp has no honest
    // implementation here — a throwing getter names the culprit if the dialer
    // contract ever breaks. (contracts 0.2.7 makes Platform bundles optional;
    // the getters stay as loud named failure modes rather than silent omissions.)
    const network: Network = {
        tcp: net,
        dns: dns as never,
        get udp(): UdpSocketFactory {
            throw new Error("unexpected access to platform.network.udp — the proxy dialer must not send datagrams");
        },
    };
    // Every non-network bundle is untouched by the dialer — each getter is a
    // named failure mode, never a silent stub.
    return {
        network,
        get crypto(): Crypto {
            throw new Error("unexpected access to platform.crypto — the proxy dialer must not touch this bundle");
        },
        get compression(): CompressionProvider {
            throw new Error("unexpected access to platform.compression — the proxy dialer must not touch this bundle");
        },
        get events(): EventProvider {
            throw new Error("unexpected access to platform.events — the proxy dialer must not touch this bundle");
        },
        get telemetry(): Telemetry {
            throw new Error("unexpected access to platform.telemetry — the proxy dialer must not touch this bundle");
        },
        get time(): Time {
            throw new Error("unexpected access to platform.time — the proxy dialer must not touch this bundle");
        },
    };
}
