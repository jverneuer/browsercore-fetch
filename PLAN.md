# @browsercore/fetch — Implementation Plan

The developer-facing HTTP surface. Implement in this order; each step is
independently testable.

## Step 1 — FetchResponse / FetchOptions types

Define the public request/response shapes (`FetchOptions`, `FetchResponse`,
`RedirectPolicy`, branded `FetchRequestId`). Done when `tsc --build` is clean.

## Step 2 — URL parsing + validation

Strict URL parser that rejects unknown schemes, normalizes the path, splits port
from host, and projects onto `ParsedUrl`. Tests: valid URLs parse; malformed
URLs throw `FetchError`.

## Step 3 — Connection establishment (transport + tls)

Open a TCP transport, perform a TLS handshake with ALPN offering `["h2",
"http/1.1"]`. Wrap lower-level errors as `FetchError` via `cause`.

## Step 4 — ALPN-driven protocol selection (h2 vs h1.1)

Branch on the ALPN-negotiated protocol: instantiate an HTTP/2 session or an
HTTP/1.1 connection. No overlap — exactly one protocol per connection.

## Step 5 — Profile application (PARTIAL)

Load the `ProfileId`-referenced profile and apply TLS parameters (cipher suite,
extensions, grease) and HTTP settings (pseudo-headers, window size) to the
selected protocol session before the first request dispatches.

— applyHttp2Profile is a no-op.

## Step 6 — Request dispatch over http1 / http2

Encode the request (method, path, headers, body) using the selected protocol.
Return a `FetchResponse` whose body resolves from the protocol's byte stream.

## Step 7 — Redirect following policy

Implement `RedirectPolicy`: `follow` (up to `maxRedirects`), `manual` (return the
redirect response), `error` (throw `RedirectError`). Track redirect count and
detect loops.

## Step 8 — Cookie jar integration (set/get per request)

Before dispatch, add matching cookies from the jar to the request. After
response, store `Set-Cookie` headers back into the jar. Honor the `cookieJar`
option per-call and per-client.

## Step 9 — Connection pooling + reuse (PARTIAL)

`FetchClient` pools connections per origin (host:port) and reuses them across
requests. HTTP/2 multiplexes over a single connection; HTTP/1.1 keeps a small
pool. Evict idle connections after a configurable timeout.

— idle eviction not implemented.

## Step 10 — Timeout + abort handling (PARTIAL)

Wire `timeoutMs` and `AbortSignal` to cancel in-flight requests and tear down
the underlying transport. Throw `FetchTimeoutError` on timeout.

— timeout timer and AbortSignal are no-ops.

## Step 11 — Streaming body support

`FetchResponse.body()` returns the full bytes for now; later expose a streaming
reader so large responses don't buffer entirely in memory.

## Definition of done

- [x] URL parsing rejects malformed input with a typed error.
- [x] ALPN selects exactly one of h2 / h1.1 per connection.
- [ ] Profile applies to both TLS and HTTP layers.
- [x] Redirect policy follows / manual / error all work; loops throw.
- [x] Cookie jar round-trips Set-Cookie on responses.
- [ ] Connection pooling reuses connections across requests.
- [ ] `timeoutMs` and `AbortSignal` cancel in-flight requests.
- [ ] Every test in `tests/` passes; `tsc --build` is clean.
