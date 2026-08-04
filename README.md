# @browsercore/fetch

[![npm version](https://img.shields.io/npm/v/@browsercore/fetch)](https://www.npmjs.com/package/@browsercore/fetch)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-fetch/main/coverage/badge.json)](https://github.com/jverneuer/browsercore-fetch/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-fetch/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-fetch/actions/workflows/ci.yml)

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

### HTTP/3

`@browsercore/http3` and `@browsercore/quic` exist but are **not yet wired into
this entrypoint** — `establishConnection` branches on ALPN to HTTP/2 or HTTP/1.1
only. They will land in a future release.

## Development

This repo shares its build, lint, test, and CI config with every other
`@browsercore/*` package via the [`@browsercore/dev`](https://github.com/jverneuer/browsercore-dev)
package — `tsconfig.json` extends its base config, `vitest.config.ts` uses its
`definePackageConfig` factory, and `oxlint.config.ts` extends its base ruleset.
All commands run from this repo's directory:

```sh
npm install          # installs @browsercore/dev and the @browsercore/* siblings
npm run build        # tsc -p tsconfig.build.json (emit to dist/)
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm run lint         # oxlint --type-aware src/
npm test             # vitest run
```

Run a **single test** with vitest's file filter:

```sh
npx vitest run tests/e2e-detection.test.ts
```

Run tests by **name pattern**:

```sh
npx vitest run -t "rejects a non-browser User-Agent"
```

Most engineers should consume this package from the top-level
[`browsersmith`](https://github.com/jverneuer/browsercore) entrypoint instead.

## License

MIT
