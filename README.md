# @browsercore/fetch

[![npm version](https://img.shields.io/npm/v/@browsercore/fetch)](https://www.npmjs.com/package/@browsercore/fetch)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-fetch/badge.json)](https://github.com/jverneuer/browsercore-fetch/blob/main/COVERAGE.md)
[![CI](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-fetch/ci.yml?label=CI)](https://github.com/jverneuer/browsercore-fetch/actions/workflows/ci.yml)

A developer-facing high-level HTTP API. Composes every lower-level package
(transport, tls, http1, http2, profiles, cookies) into a single `fetch()` surface
with browser-accurate TLS + HTTP fingerprints.

## Responsibility

URL parsing, connection reuse, profile loading, redirect policy, cookie
integration, and automatic protocol selection (h2 vs h1.1 via ALPN). Top of the
dependency stack — every other `@browsercore/*` package sits below this one.

## Runtime dependencies via Platform

fetch has no runtime bindings of its own. Every capability it needs at
runtime — events, TCP, DNS, crypto, compression — is injected through a single
[`Platform`](https://github.com/jverneuer/browsercore-contracts) object that
`browsersmith` (the composition root) assembles and passes down:

```ts
import { fetch } from "@browsercore/fetch";
import { browsersmith } from "browsersmith";

// browsersmith builds the Platform; fetch consumes it. No global singletons,
// no fallback providers — fetch throws if a required capability is missing.
const platform = browsersmith.createPlatform();
const response = await fetch("https://example.com", { profile: "chrome-140" }, platform);
```

`createClient` resolves each capability from `platform`, falling back to an
explicit individual option when one is provided (useful to override a single
adapter):

| Capability | Platform field | Individual fallback |
| --- | --- | --- |
| events | `platform.events` | `options.events` |
| TCP | `platform.network.tcp` | `options.net` |
| DNS | `platform.network.dns` | `options.dns` |
| crypto | `platform.crypto.provider` | `options.crypto` |
| compression | `platform.compression` | `options.compression` |

`events` is mandatory with no fallback — fetch never creates its own provider.

## Public API

```ts
import { fetch, createClient, FetchTimeoutError } from "@browsercore/fetch";

// One-shot convenience fetch (creates + closes a default client).
// Requires a Platform — see "Runtime dependencies via Platform" above.
const response = await fetch("https://example.com", { profile: "chrome-140" }, platform);
console.log(response.status, await response.text());

// Reusable client for connection pooling + defaults:
const client = createClient({ profile: "chrome-140", platform });
try {
    const r1 = await client.fetch("https://example.com");
    const r2 = await client.fetch("https://example.com/api", { method: "POST" });
} finally {
    await client.close();
}
```

### Connection pooling

Connections are pooled per origin (host:port) and reused across requests. A
connection unused for `idleTimeoutMs` (default 30 000, `0` disables) is closed
and evicted. Connections the SERVER closes while pooled (LB idle timeouts,
GOAWAY, FINs) are evicted the moment the transport reports the close; a request
that would otherwise take an already-dead connection redials transparently
within the same request. Client-initiated closes (`client.close()`) and idle
eviction are unaffected.

### Proxied requests

Every request (or a whole client, via `FetchClientOptions.proxy`) can be
tunneled through an HTTP CONNECT or SOCKS5/5h proxy via `@browsercore/proxy`.
Proxied connections are pooled per origin+proxy pair — different proxies never
share a connection — and proxy failures surface as `FetchProxyError` with the
wrapped `kind` preserved on `proxyKind`.

```ts
const client = createClient({
    platform,
    proxy: { scheme: "socks5h", host: "127.0.0.1", port: 1080 }, // client default
});
// Per-request proxy replaces the client default:
const r = await client.fetch("https://example.com", {
    proxy: { scheme: "http", host: "127.0.0.1", port: 8080 },
});
```

## Types

| Export | Kind | Purpose |
| --- | --- | --- |
| `fetch()` | function | Top-level convenience — creates a default client |
| `createClient()` | function | Build a reusable client with defaults |
| `FetchClient` | interface | Reusable client (fetch + close) |
| `FetchClientOptions` | interface | Client defaults (cookie jar, profile, timeout, Platform) |
| `FetchOptions` | interface | Per-request options (method, headers, body, profile, signal, …) |
| `FetchResponse` | interface | Response (status, headers, body()/json()/text(), clone()) |
| `FetchMethod` | type union | `GET \| POST \| PUT \| PATCH \| DELETE \| HEAD \| OPTIONS` |
| `RedirectPolicy` | discriminated union | `{ kind: "follow" } \| { kind: "manual" } \| { kind: "error" }` |
| `FetchError` | class | Base typed error (kind/details/cause) |
| `FetchTimeoutError` | class | Request exceeded timeout |
| `RedirectError` | class | Redirect loop / limit exceeded |
| `ProtocolError` | class | ALPN negotiation failure |
| `FetchProxyError` | class | Proxy tunnel failure (wrapped proxy `kind` on `proxyKind`) |
| `AbortError` | class | Request aborted via AbortSignal |
| `ProxyConfig` / `ProxyScheme` | type re-export | Proxy endpoint shape (from `@browsercore/proxy`) |

## Dependency graph

```
@browsercore/fetch
  └─ @browsercore/http2  @browsercore/http1  @browsercore/cookies  @browsercore/profiles  @browsercore/proxy
        └─ @browsercore/tls
              └─ @browsercore/crypto  @browsercore/compression  @browsercore/transport
                    └─ node:net / node:crypto / node:zlib
```

No package above `@browsercore/fetch` imports from below it.
