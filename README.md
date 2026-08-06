# @browsercore/fetch

[![npm version](https://img.shields.io/npm/v/@browsercore/fetch.svg)](https://www.npmjs.com/package/@browsercore/fetch)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-fetch/badge.json)](https://github.com/jverneuer/browsercore-fetch/blob/main/COVERAGE.md)
[![license](https://img.shields.io/npm/l/@browsercore/fetch.svg)](LICENSE)

A developer-facing high-level HTTP API. Composes every lower-level package
(transport, tls, http1, http2, profiles, cookies) into a single `fetch()` surface
with browser-accurate TLS + HTTP fingerprints.

## Responsibility

URL parsing, connection reuse, profile loading, redirect policy, cookie
integration, and automatic protocol selection (h2 vs h1.1 via ALPN). Top of the
dependency stack — every other `@browsercore/*` package sits below this one.

## Public API

```ts
import { fetch, createClient, FetchTimeoutError } from "@browsercore/fetch";

// One-shot convenience fetch (creates + closes a default client):
const response = await fetch("https://example.com", { profile: "chrome-140" });
console.log(response.status, await response.text());

// Reusable client for connection pooling + defaults:
const client = await createClient({ profile: "chrome-140" });
try {
    const r1 = await client.fetch("https://example.com");
    const r2 = await client.fetch("https://example.com/api", { method: "POST" });
} finally {
    await client.close();
}
```

## Types

| Export | Kind | Purpose |
| --- | --- | --- |
| `fetch()` | function | Top-level convenience — creates a default client |
| `createClient()` | function | Build a reusable client with defaults |
| `FetchClient` | interface | Reusable client (fetch + close) |
| `FetchOptions` | interface | Per-request options (method, headers, body, profile, …) |
| `FetchResponse` | interface | Response (status, headers, body()/json()/text()) |
| `RedirectPolicy` | discriminated union | `follow \| manual \| error` |
| `FetchError` | class | Base typed error |
| `FetchTimeoutError` | class | Request exceeded timeout |
| `RedirectError` | class | Redirect loop / limit exceeded |
| `ProtocolError` | class | ALPN negotiation failure |

## Dependency graph

```
@browsercore/fetch
  └─ @browsercore/http2  @browsercore/http1  @browsercore/cookies  @browsercore/profiles
        └─ @browsercore/tls
              └─ @browsercore/crypto  @browsercore/compression  @browsercore/transport
                    └─ node:net / node:crypto / node:zlib
```

No package above `@browsercore/fetch` imports from below it.
