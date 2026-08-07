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

## Public API

```ts
import { fetch, createClient, FetchTimeoutError } from "@browsercore/fetch";

// One-shot convenience fetch (creates + closes a default client):
const response = await fetch("https://example.com", { profile: "chrome-140" });
console.log(response.status, await response.text());

// Reusable client for connection pooling + defaults:
const client = createClient({ profile: "chrome-140" });
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
| `FetchClientOptions` | interface | Client defaults (cookie jar, profile, timeout, net/dns adapters) |
| `FetchOptions` | interface | Per-request options (method, headers, body, profile, signal, …) |
| `FetchResponse` | interface | Response (status, headers, body()/json()/text(), clone()) |
| `FetchMethod` | type union | `GET \| POST \| PUT \| PATCH \| DELETE \| HEAD \| OPTIONS` |
| `RedirectPolicy` | discriminated union | `{ kind: "follow" } \| { kind: "manual" } \| { kind: "error" }` |
| `FetchError` | class | Base typed error (kind/details/cause) |
| `FetchTimeoutError` | class | Request exceeded timeout |
| `RedirectError` | class | Redirect loop / limit exceeded |
| `ProtocolError` | class | ALPN negotiation failure |
| `AbortError` | class | Request aborted via AbortSignal |

## Dependency graph

```
@browsercore/fetch
  └─ @browsercore/http2  @browsercore/http1  @browsercore/cookies  @browsercore/profiles
        └─ @browsercore/tls
              └─ @browsercore/crypto  @browsercore/compression  @browsercore/transport
                    └─ node:net / node:crypto / node:zlib
```

No package above `@browsercore/fetch` imports from below it.
