# @browsercore/fetch

[![npm version](https://img.shields.io/npm/v/@browsercore/fetch)](https://www.npmjs.com/package/@browsercore/fetch)
[![CI](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-fetch/ci.yml?label=ci)](https://github.com/jverneuer/browsercore-fetch/actions/workflows/ci.yml)

A developer-facing high-level HTTP API. Composes every lower-level package
(transport, tls, http1, http2, profiles, cookies) into a single `fetch()` surface
with browser-accurate TLS + HTTP fingerprints.

## Install

```sh
npm install @browsercore/fetch
```

Most users want **[browsersmith](https://www.npmjs.com/package/browsersmith)** instead. It's the composition root that ships a ready-made Node Platform, profiles, and cookie jar. Install fetch directly when you bring your own `Platform`: custom transports, embedded runtimes, tests.

## Responsibility

URL parsing, connection reuse, profile loading, redirect policy, cookie
integration, and automatic protocol selection (h2 vs h1.1 via ALPN). Top of the
dependency stack: every other `@browsercore/*` package sits below this one.

## Runtime dependencies via Platform

fetch has no runtime bindings of its own. Every capability it needs at
runtime (events, TCP, DNS, crypto, compression, time) is injected through a
single [`Platform`](https://github.com/jverneuer/browsercore-contracts) object
that `browsersmith` (the composition root) assembles and passes down:

```ts
import { fetch } from "@browsercore/fetch";
import { browsersmith } from "browsersmith";

// browsersmith builds the Platform; fetch consumes it. No global singletons,
// no fallback providers: fetch throws if a required capability is missing.
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
| time | `platform.time` | `options.clock` |

`events` is mandatory and has no fallback; fetch never creates its own provider.

## Time: platform.time is honored

Every timer fetch arms runs on the canonical `Clock` from
`@browsercore/contracts`, resolved once per client as
`options.clock ?? platform.time ?? systemClock`:

- the **whole-request timeout** (`timeoutMs`, default 30 000) that backs
  `FetchTimeoutError`, and
- the **pool idle-eviction timers** (`idleTimeoutMs`, default 30 000).

`systemClock` (exported) delegates to the platform globals (`Date.now()`,
`performance.now()`, `setTimeout`/`clearTimeout`), so the default behavior is
unchanged. For deterministic testing, inject a manual-advance `Clock` via
`options.clock` (or `platform.time`): both timeout kinds then fire at exact
virtual instants with zero real timers. See `tests/deterministic-clock.test.ts`.

```ts
import { createClient, type Clock } from "@browsercore/fetch";

const manual: Clock = { /* now, monotonic, sleep, setTimeout, clearTimeout */ };
const client = createClient({ clock: manual, timeoutMs: 500 });
```

## Public API

```ts
import { fetch, createClient, FetchTimeoutError } from "@browsercore/fetch";

// One-shot convenience fetch (creates + closes a default client).
// Requires a Platform (see "Runtime dependencies via Platform" above).
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
Proxied connections are pooled per origin+proxy pair, so different proxies never
share a connection. Proxy failures surface as `FetchProxyError` with the
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
| `fetch()` | function | Top-level convenience, creates a default client |
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
| `ProxyConfig` / `ProxyScheme` | type re-export | Proxy endpoint shape, canonical home `@browsercore/contracts` |
| `ProfileId` | type re-export | Browser profile id, canonical home `@browsercore/contracts` |
| `Clock` / `TimerHandle` | type re-export | Injected time source, canonical home `@browsercore/contracts` |
| `systemClock` | const | Default `Clock` over the platform globals |

The option types speak canonical `@browsercore/contracts` types
(`ProxyConfig`, `ProfileId`, `Clock`, `Transport`, `CryptoProvider`);
`@browsercore/proxy` and `@browsercore/profiles` re-export the same canonical
types, so imports from either name keep compiling. One deliberate exception:
`CookieJar` still comes from `@browsercore/cookies`. contracts' `CookieJar`
declaration (`setCookie(url, cookie)`) is not yet reconciled with the jar
cookies implements (`setCookie(raw, url)`); cookie reconciliation is deferred
and guarded by drift alarms in cookies 0.2.2.

## Dependency graph

```
@browsercore/fetch
  └─ @browsercore/http2  @browsercore/http1  @browsercore/cookies  @browsercore/profiles  @browsercore/proxy
        └─ @browsercore/tls
              └─ @browsercore/crypto  @browsercore/compression  @browsercore/transport
                    └─ node:net / node:crypto / node:zlib
```

No package above `@browsercore/fetch` imports from below it.

## Contributing

Contributions are welcome: bug reports, reproductions, docs and code alike. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the full guide lives in the [browsersmith repo](https://github.com/jverneuer/browsersmith/blob/main/CONTRIBUTING.md). First timer? Check the [`good first issue`](https://github.com/jverneuer/browsercore-fetch/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Security issues: [SECURITY.md](SECURITY.md), never a public issue.

## License

MIT
---

<div align="center">

🦄 You scrolled past the entire dependency graph to get here. That earns you a unicorn, and per unicorn statute §1 your day will now be amazing. Congratulations.

</div>
