# Orbital — Architecture

> How the pieces fit together. This document is the map a new contributor reads
> before opening a PR, the reviewer consults before approving one, and the
> grant committee reads to understand what is actually being built.
>
> Where something ships today it is marked ✅; where it is planned it is
> marked 🛠️ and the milestone is named.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Component inventory & repo layout](#2-component-inventory--repo-layout)
3. [Event lifecycle](#3-event-lifecycle)
4. [The normalization layer](#4-the-normalization-layer)
5. [Reconnection, backoff, and rate limits](#5-reconnection-backoff-and-rate-limits)
6. [Webhook delivery internals](#6-webhook-delivery-internals)
7. [React hook internals](#7-react-hook-internals)
8. [Trust boundaries and invariants](#8-trust-boundaries-and-invariants)
9. [Reference composition (`apps/web`)](#9-reference-composition-appsweb)
10. [Phase 1 evolution](#10-phase-1-evolution)
11. [File map](#11-file-map)

---

## 1. System overview

Orbital is three planes sharing one vocabulary — the **normalized event**:

- **Subscription plane** — `@orbital/pulse-core` opens and maintains a
  connection to Stellar (Horizon today, Stellar RPC + Soroban in Phase 1),
  normalizes raw operations into a typed `NormalizedEvent` union, and routes
  each event to per-address `Watcher` subscribers.
- **Delivery plane** — `@orbital/pulse-webhooks` attaches to a `Watcher`,
  signs each event with HMAC-SHA256, and POSTs it to one or more HTTPS
  endpoints with retry, timeout, and SSRF safety. A second export
  (`verifyWebhookEdge`) lets receivers verify the signature on Cloudflare
  Workers, Vercel Edge, Deno, and browsers without Node `crypto`.
- **Consumption plane** — `@orbital/pulse-notify` opens a browser
  `EventSource` to a backend that re-emits the events as Server-Sent
  Events, and re-renders React components on each event.

```mermaid
flowchart LR
  subgraph Stellar["Stellar network"]
    Horizon["Horizon REST + SSE"]
    RPC["Stellar RPC<br/>Soroban — 🛠️ Phase 1"]
  end

  subgraph Subscribe["Subscription plane<br/>@orbital/pulse-core"]
    Engine["EventEngine"]
    Normalize["Normalize<br/>13 op types → 21 events"]
    Watcher["Watcher<br/>per-address pub/sub"]
  end

  subgraph Deliver["Delivery plane<br/>@orbital/pulse-webhooks"]
    Sign["HMAC-SHA256<br/>+ retry + SSRF + timeout"]
    Verify["verifyWebhook<br/>verifyWebhookEdge"]
  end

  subgraph Consume["Consumption plane<br/>@orbital/pulse-notify"]
    Hooks["useStellarEvent<br/>useStellarPayment<br/>useStellarActivity"]
  end

  Horizon --> Engine
  RPC -.-> Engine
  Engine --> Normalize --> Watcher
  Watcher --> Sign --> YourEndpoint["Your HTTPS endpoint"]
  YourEndpoint --> Verify
  Watcher --> SSE["Your SSE endpoint"]
  SSE --> Hooks --> ReactApp["React app"]
```

Each plane is independently installable from npm (Phase 1 publish) and
independently composable. The reference composition that powers the marketing
demo at `apps/web/app/api/events/[address]/route.ts` shows all three wired
together inside a single Next.js route handler — about 50 lines of glue.

---

## 2. Component inventory & repo layout

| Component | Role | Path | Status |
|---|---|---|---|
| **`EventEngine`** | Owns the Horizon SSE stream, the reconnection state machine, the watcher registry, and the normalization pipeline. | `packages/pulse-core/src/EventEngine.ts` | ✅ |
| **`Watcher`** | `EventEmitter` keyed by Stellar address. Subscribers add listeners; the engine routes each normalized event to the matching watcher(s). | `packages/pulse-core/src/Watcher.ts` | ✅ |
| **Normalizers** | One method per Horizon operation type. Each returns a typed `NormalizedEvent` or `null` if the record is malformed. | `packages/pulse-core/src/EventEngine.ts` (`normalize*`) | ✅ |
| **`WebhookDelivery`** | Attaches to a `Watcher`, signs each event, POSTs it with retry + timeout + concurrent-retry cap. Emits `webhook.failed` / `webhook.dropped` on terminal failure. | `packages/pulse-webhooks/src/index.ts` | ✅ |
| **`verifyWebhook`** | Node-side HMAC verifier using `crypto.timingSafeEqual`. | `packages/pulse-webhooks/src/index.ts` | ✅ |
| **`verifyWebhookEdge`** | Edge-runtime HMAC verifier using Web Crypto API + constant-time XOR. | `packages/pulse-webhooks/src/edge.ts` | ✅ |
| **`useStellarEvent<T>`** | React hook that opens an `EventSource`, parses incoming SSE messages, optionally filters by event type, and re-renders on each event. Stable dep-array via sorted `eventKey`. | `packages/pulse-notify/src/index.ts` | ✅ |
| **`useStellarPayment` / `useStellarActivity`** | Convenience wrappers over `useStellarEvent`. | `packages/pulse-notify/src/index.ts` | ✅ |
| **Reference composition** | A Next.js Node-runtime route handler that subscribes to an address and streams events as SSE; plus a `webhook-sample` route that returns an HMAC-signed payload for the demo. | `apps/web/app/api/events/[address]/route.ts`, `apps/web/app/api/webhook-sample/route.ts` | ✅ |
| **Soroban subscriber** | Subscribes to Stellar RPC for contract events, decodes via the ABI Registry, normalizes into the same `NormalizedEvent` union. | `packages/pulse-core` (planned) | 🛠️ Phase 1 |
| **Cursor persistence** | Pluggable durable store for the Horizon and Soroban cursors so a process restart resumes from where it left off. Cursor formats documented in [`docs/cursor-format.md`](./cursor-format.md). | `packages/pulse-core` (planned) | 🛠️ Phase 1 |
| **Replay adapters** | Pluggable durable queues (Redis / Postgres / S3) for in-flight webhook retries. | `packages/pulse-webhooks` (planned) | 🛠️ Phase 1 |

---

## 3. Event lifecycle

End-to-end for a single payment event from on-chain to React render:

```mermaid
sequenceDiagram
  participant Network as Stellar network
  participant Engine as EventEngine
  participant Normalizer as normalize()
  participant Registry as Watcher registry
  participant Webhooks as WebhookDelivery
  participant Hook as useStellarEvent
  participant Endpoint as Your HTTPS endpoint
  participant App as React app

  Network->>Engine: SSE operation record
  Engine->>Normalizer: route record by type
  Normalizer-->>Engine: NormalizedEvent (payment.received)
  Engine->>Registry: route(event)
  Registry->>Webhooks: watcher.emit("payment.received", event)
  Registry->>Hook: SSE message → setState
  Webhooks->>Endpoint: POST { x-orbital-signature, x-orbital-timestamp, body }
  Endpoint-->>Webhooks: 200 OK
  Hook->>App: re-render with new event
```

Steps in detail:

1. **Subscribe.** Caller invokes `engine.subscribe(address)`. The engine
   creates a new `Watcher` (or returns an existing one), registers a
   `stopHandler` for cleanup, and stores any optional `filter` predicate.
2. **Ingest.** Horizon streams an operation record. The engine's `onmessage`
   callback updates `lastEventAt` and asks the normalizer to map the record
   to a `NormalizedEvent`. Records that don't match any known op type are
   dropped silently; records that fail field validation are dropped with a
   warn log.
3. **Route.** Each event type has a routing rule encoded in
   `EventEngine.route()`. Payments route to both `from` and `to` watchers;
   account merges to source and destination; trust-auth events to issuer and
   trustor; claimables to every claimant plus the sponsor. The same event
   never delivers to the same watcher twice.
4. **Filter.** If the subscriber passed a `filter` predicate, the engine
   calls it; a `false` return suppresses delivery. A thrown predicate is
   treated as `false` and logged as a warning — the stream stays up.
5. **Emit.** The watcher emits the event under its discriminated type
   (`"payment.received"`) and also under the wildcard `"*"`. Consumers can
   listen to either or both.
6. **Deliver.** Any `WebhookDelivery` attached to the watcher signs the
   payload, POSTs it, and handles retry on failure. Any `useStellarEvent`
   hook attached via SSE receives the event and updates React state.

---

## 4. The normalization layer

Horizon's operation records are denormalized JSON keyed by operation type.
`pulse-core` exposes them as a single discriminated union so consumers can
exhaustively switch on `event.type`:

```ts
type NormalizedEvent =
  | PaymentEvent
  | AccountOptionsEvent
  | AccountCreatedEvent
  | TrustlineEvent
  | AccountMergeEvent
  | OfferEvent
  | BumpSequenceEvent
  | DataEvent
  | ClaimableCreatedEvent
  | ClaimableClaimedEvent
  | LiquidityPoolDepositEvent
  | LiquidityPoolWithdrawEvent
  | TrustAuthEvent;
```

The 13 Horizon operation types map to **21 normalized event types** — the
difference comes from operations that fan out into multiple semantic events
(a `change_trust` becomes one of `trustline.added`, `trustline.removed`, or
`trustline.updated` depending on the new limit; a `manage_sell_offer` becomes
one of `offer.created`, `offer.updated`, or `offer.deleted` depending on the
offer ID and amount).

Asset encoding is normalized to a single string: `"XLM"` for native, or
`"CODE:ISSUER"` for credit assets. This sidesteps the Horizon convention of
`asset_type` + `asset_code` + `asset_issuer` triples in every operation.

The full taxonomy is documented in
[`packages/pulse-core/README.md`](../packages/pulse-core/README.md#event-taxonomy)
and the per-event TypeScript shapes live in
[`packages/pulse-core/src/index.ts`](../packages/pulse-core/src/index.ts).

---

## 5. Reconnection, backoff, and rate limits

Horizon's SSE stream is not durable. Network blips, process restarts, and
upstream maintenance windows all surface as `onerror` callbacks. The
reconnection state machine is the single most load-bearing piece of
`pulse-core` for production reliability.

### Backoff policy

The engine uses **AWS Full Jitter**: each reconnect delay is a uniform random
value between `0` and `min(initialDelayMs × 2^(attempt-1), maxDelayMs)`. This
avoids the thundering-herd problem where every dropped client reconnects on
the same millisecond when Horizon comes back.

Defaults: `initialDelayMs: 1000`, `maxDelayMs: 30000`, `maxRetries: ∞`. All
three are overridable via `CoreConfig.reconnect`.

### Rate-limit handling

A `429 Too Many Requests` response is not treated as a generic error. The
engine parses the `Retry-After` header (either integer seconds or an HTTP
date), schedules the reconnect for exactly that delay, and emits an
`engine.rate_limited` notification on every watcher so consumers can show
banners or pause publishers. If the header is missing or malformed, the
engine falls back to a 60-second delay (longer than the exponential default).

### Lifecycle notifications

Every watcher receives lifecycle notifications alongside operation events:

| Notification | When |
|---|---|
| `engine.reconnecting` | Backoff delay started; will reconnect in `delayMs` |
| `engine.reconnected` | Reconnect succeeded on attempt `N` |
| `engine.rate_limited` | 429 received; reconnect deferred by `delayMs` |
| `engine.stopped` | `engine.stop()` was called explicitly |

Consumers can subscribe to these via `watcher.on("engine.reconnecting", …)`
to surface UI banners or write structured logs.

---

## 6. Webhook delivery internals

`WebhookDelivery` is a thin wrapper around `fetch` with five concerns:

1. **Signing.** HMAC-SHA256 over `${timestamp}.${payload}`, where `payload`
   is the JSON-serialized `NormalizedEvent`. The signature is hex-encoded
   and sent as the `x-orbital-signature` header. The timestamp prevents
   replay attacks; receivers should reject signatures older than a small
   window (recommended: 5 minutes).
2. **Timeout.** Each attempt has an `AbortController` cap (default 10 s,
   tunable via `deliveryTimeoutMs`). A timed-out attempt counts as a failure
   and triggers retry.
3. **Retry.** On any non-2xx response, network error, or timeout, the
   delivery schedules a retry after a jittered exponential delay (`2^(n-1)
   × 1000ms × Math.random()`). The default cap is 3 attempts.
4. **Concurrent-retry cap.** If too many endpoints are slow, retries can
   accumulate and exhaust memory. The cap (`maxConcurrentRetries`, default
   100) evicts the *newest* pending retry first when the limit is hit and
   emits a synthetic `webhook.dropped` event so consumers can route it to a
   dead-letter store.
5. **Terminal failure.** After all retries are exhausted, the delivery
   emits `webhook.failed` on the watcher with `{ error, url, attempts,
   originalEvent }` in `raw`. The watcher's `on("webhook.failed", …)`
   handler is the dead-letter integration point.

### SSRF safety

Delivery targets are validated at construction time and re-validated against
DNS resolution before each request. Loopback (`127.0.0.0/8`, `::1`), private
RFC 1918 ranges, and link-local (`169.254.0.0/16`) addresses are blocked by
default. Setting `allowPrivateNetworks: true` opts out — useful for local
development, never appropriate for production.

### Edge-runtime verification

`verifyWebhookEdge` is a parallel implementation of `verifyWebhook` that
uses Web Crypto's `crypto.subtle.sign` instead of Node's `createHmac`. It
runs on Cloudflare Workers, Vercel Edge, Deno, and browsers — anywhere with
the standard `crypto.subtle` API. The constant-time XOR comparison
substitutes for Node's `timingSafeEqual`.

This matters because the most common webhook receiver shape on Stellar
today is a Cloudflare Worker or a Vercel Edge route, and the Node crypto
verifier doesn't load there.

---

## 7. React hook internals

`useStellarEvent<T>` is intentionally thin: it acquires a pooled
`EventSource` connection and applies a per-hook event filter, with three
design choices worth noting.

**Connection pooling.** Hook instances with the same `serverUrl`, `address`,
and `token` share one browser `EventSource`; the pool closes that connection
when the last hook using the key unmounts.

**Stable dep-array.** An array literal passed as the `event` allowlist
would otherwise be a new reference every render and re-run the effect
continuously. The hook serializes the allowlist to a sorted string
(`eventKey`) and uses that as the dep instead.

**Dual call signature.** The hook accepts both a config object
(`useStellarEvent({ serverUrl, address, event })`) and a positional form
(`useStellarEvent(serverUrl, address, { event })`). The two are normalized
to the same four primitives before the effect runs.

**Generic type narrowing.** Passing a narrower union as `T` lets consumers
exhaustively switch on `event.type` without manual casts:

```tsx
type WalletEvents = Extract<NormalizedEvent, { type: "payment.received" | "payment.sent" }>;
const { event } = useStellarEvent<WalletEvents>(url, address, { event: ["payment.received", "payment.sent"] });
```

The hook is browser-only — `EventSource` doesn't exist in Node. In Next.js
App Router, mark consuming components with `"use client"`. In Remix or Vite
SSR, gate the hook behind a client-only boundary.

---

## 8. Trust boundaries and invariants

| Boundary | Inside | Outside | Mitigation |
|---|---|---|---|
| **Webhook signature** | The signed `${timestamp}.${payload}` body emitted by `WebhookDelivery`. | Network, intermediate proxies, the receiver's logs. | HMAC-SHA256 with a shared secret; `verifyWebhook` uses timing-safe comparison. |
| **Webhook target URL** | The host configured by the operator. | The DNS resolver and the network it points at. | SSRF block-list on construction *and* re-validated post-DNS to defend against DNS rebinding. |
| **SSE stream from Stellar** | `EventEngine` → `Watcher` callbacks. | Horizon, intermediate CDNs. | The engine treats every record as untrusted input — every field is `typeof`-checked before normalization; malformed records are dropped with a warn log, not thrown. |
| **API key on the demo backend** | A single `process.env.NEXT_PUBLIC_NETWORK`-validated singleton. | Public internet, every visitor. | The demo enforces a 1-stream-per-IP concurrency cap and a 25s session timer; production self-hosters should swap in their own auth (the SDKs do not prescribe one). |
| **HMAC secret** | The operator's secret store. | Source control, logs, debug output. | The reference composition reads from env; consumers are expected to use a secrets manager. |

### Invariants

- An `EventEngine` only ever holds one upstream connection at a time.
  `start()` is idempotent (returns `false` if already running, unless
  `strict: true` is passed).
- A `Watcher` only ever delivers to a given subscriber once per event.
- A `WebhookDelivery` retries each URL independently; one slow endpoint
  does not block delivery to the others.
- A stopped `Watcher` accepts no new listeners and emits no further events.
  Adding a listener after `stop()` is a no-op with a warn log.

---

## 9. Reference composition (`apps/web`)

The marketing site doubles as the runnable reference for "how do I wire
this together end-to-end?" Two API routes show the composition:

| Route | Powers | Cost-control |
|---|---|---|
| `GET /api/events/[address]` | The on-page Live Demo. Subscribes to the address, streams events as SSE, closes after the session cap. | 1 concurrent stream per IP; 25s max session. |
| `POST /api/webhook-sample` | The on-page Webhook Demo. Returns a real HMAC-SHA256-signed sample payload with `x-orbital-*` headers. | 1 signing request per IP per 20s. |

Both routes share a lazy `globalThis`-scoped `EventEngine` singleton
(`apps/web/lib/engine.ts`) that survives Next.js HMR. When the limits
trigger, the routes return a JSON envelope
(`{ error: "demo_limit_reached", reason, message, upgradeUrl }`) that the
React components surface as an "Upgrade to Orbital Cloud" CTA.

For production self-hosting, copy the route handlers, strip the limit
checks in `lib/demo-limits.ts`, and swap the in-memory singleton for a
proper process manager. The whole composition is under 200 lines of TS.

---

## 10. Phase 1 evolution

Where Phase 1 (`v1.0`, Q2–Q3 2026) bolts on without changing the public
API:

- **Soroban event subscription.** A second source feeding into the same
  normalization pipeline. New event types
  (`contract.invoked`, `contract.emitted`) join the `NormalizedEvent` union;
  existing consumers ignore them unless they subscribe.
- **ABI Registry client.** Decodes Soroban event topics + data into typed,
  human-readable JSON. Lives as a separate package (`@orbital/abi-registry`
  TBD) so the registry data layer is independently versioned.
- **Cursor persistence.** A pluggable `CursorStore` interface stored on
  `EventEngine` config. Implementations: in-memory (default, current
  behavior), local file, Redis, Postgres, S3. On reconnect, the engine
  resumes from the stored cursor instead of `"now"`. Cursor format
  specifications and adapter implementation patterns are documented in
  [`docs/cursor-format.md`](./cursor-format.md).
- **Replay adapters.** A pluggable `RetryQueue` interface on
  `WebhookDelivery`. Implementations: in-memory (current), Redis, Postgres,
  SQS. Pending retries survive process restarts.
- **Discriminated union refinement.** Today the `NormalizedEvent` union is
  discriminated by `type` but several fields are `unknown` for type-safety
  reasons (the raw Horizon record). Phase 1 narrows these to typed shapes
  with the help of generated schemas from Horizon's OpenAPI.

The upgrade path for existing consumers is: `pnpm update` to `v1.x`,
optionally pass new config (`cursorStore`, `retryQueue`), keep their
existing `on()` handlers unchanged.

---

## 11. File map

```
orbital_stellar/
├── packages/                      # Published SDKs (MIT, npm)
│   ├── pulse-core/
│   │   ├── src/
│   │   │   ├── EventEngine.ts     # ~1100 lines — engine + normalizers + routing
│   │   │   ├── Watcher.ts         # EventEmitter wrapper with stop-handler hooks
│   │   │   ├── errors.ts          # EngineAlreadyStartedError
│   │   │   └── index.ts           # Public types + barrel exports
│   │   ├── test/                  # Vitest suites (103 passing)
│   │   └── bench/throughput.ts    # tsx benchmark harness
│   ├── pulse-webhooks/
│   │   ├── src/
│   │   │   ├── index.ts           # WebhookDelivery + verifyWebhook (Node)
│   │   │   ├── edge.ts            # verifyWebhookEdge (Web Crypto)
│   │   │   └── types.ts           # WebhookConfig
│   │   └── test/                  # Vitest suites (13 passing)
│   └── pulse-notify/
│       └── src/index.ts           # ~120 lines — three React hooks
├── apps/
│   └── web/                       # Marketing site + reference composition
│       ├── app/
│       │   ├── api/
│       │   │   ├── events/[address]/route.ts   # Reference SSE handler
│       │   │   └── webhook-sample/route.ts     # HMAC-signed sample
│       │   ├── docs/              # File-based MD docs with TOC
│       │   └── page.tsx           # Marketing landing
│       ├── components/            # LiveDemo, WebhookDemo, Nav, Hero, …
│       ├── content/               # Markdown sources for /docs
│       └── lib/
│           ├── engine.ts          # globalThis EventEngine singleton
│           ├── network.ts         # NEXT_PUBLIC_NETWORK validation
│           └── demo-limits.ts     # Per-IP + per-session caps
├── docs/                          # Strategic + reference docs (this dir)
├── .github/workflows/             # CI, CodeQL, security, integration, release
├── PROGRESS.md                    # Phase 0 status snapshot
├── ROADMAP.md                     # Multi-year phase plan
├── CHANGELOG.md                   # Rolled-up release notes
└── CONTRIBUTING.md                # Dev loop + PR conventions
```

---

## Related documents

- [`PROGRESS.md`](../PROGRESS.md) — Phase 0 completion checklist
- [`ROADMAP.md`](../ROADMAP.md) — Phase 0 → Phase 4 timeline
- [`CHANGELOG.md`](../CHANGELOG.md) — Per-release notes
- [`docs/proposal.md`](./proposal.md) — SCF grant proposal
- Per-package READMEs:
  [`pulse-core`](../packages/pulse-core/README.md),
  [`pulse-webhooks`](../packages/pulse-webhooks/README.md),
  [`pulse-notify`](../packages/pulse-notify/README.md)
