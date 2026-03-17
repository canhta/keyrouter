# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start          # Start the server
bun test               # Run all tests
bun run typecheck      # TypeScript type check (no emit)
bun --hot run bin/keyrouter.ts  # Hot-reload dev mode
bun run bin/keyrouter.ts auth copilot  # Authenticate a provider
```

Run a single test file:
```bash
bun test tests/unit/routing.test.ts
bun test tests/integration/chat-completions.test.ts
```

Pre-commit hook runs `typecheck`; pre-push hook runs `bun test`.

## Stack

- **Runtime**: Bun (not Node.js) — native TypeScript, `bun:sqlite` built-in, no transpile step
- **Web framework**: Hono v4
- **Database**: SQLite via `bun:sqlite` (no ORM, raw SQL)
- **No ESLint/Prettier** — strict TypeScript (`noUncheckedIndexedAccess`, `strict: true`) is the linter

## Architecture

Keyrouter is an OpenAI-compatible proxy that routes to multiple AI providers (GitHub Copilot, OpenAI, OpenRouter, etc.) with credential management, account rotation, and a management dashboard.

### Request flow for `POST /v1/chat/completions`

1. Auth guard (Bearer token via `timingSafeEqual`) → 401
2. Body size limit (1MB) → 413
3. `ModelRegistry.lookup(modelId)` → 404 if unknown
4. `RoutingStrategy.selectAccounts()` → ordered list (unlocked first, round-robin; locked sorted by soonest-available)
5. Retry loop over accounts:
   - `SqliteCredentialStore.resolve()` — reads SQLite, refreshes OAuth tokens with in-flight dedup
   - `ProviderDefinition.requestHeaders(cred)` — builds auth + capability headers
   - `fetch(provider.baseUrl + endpoint)` — 5xx/429 → `onError()` + continue; 401 → attempt refresh → if still 401 → `OAuthRevokedError`
6. Stream: pipe through `UsageSynthesisTransform` (SSE parse, synthesize usage before `[DONE]`, fire-and-forget `usageStore.record()`)

### Key components

| Component | File | Purpose |
|-----------|------|---------|
| `ModelRegistry` | `registry/index.ts` | Lookup by model ID; atomic hot-swap on config change |
| `SqliteCredentialStore` | `auth/store.ts` | Credential resolution + OAuth refresh with in-flight dedup |
| `DefaultRoutingStrategy` | `routing/strategy.ts` | Round-robin account selection + lock backoff |
| `LockStore` | `routing/lock-store.ts` | Per-(account, model) exponential backoff (30s→60s→5m→30m) |
| `UsageSynthesisTransform` | `translation/stream.ts` | SSE transformer — synthesizes usage chunk if provider omits it |
| `DashboardEventBus` | `events/bus.ts` | SSE pub/sub for real-time dashboard updates |
| All shared types | `src/types.ts` | Single source of truth — read this first |

### Config hot-reload

`fs.watch('router.json')` → `registry.swap(newConfig)` — atomic reference replacement. In-flight requests hold old ref; new requests pick up new one. Partial writes (JSON.parse throws) are silently ignored until next valid write.

### Adding a provider

1. Add a `ProviderDefinition` in `src/providers/<name>.ts`
2. Register it in `src/providers/index.ts`
3. If OAuth: add an `OAuthProvider` class in `src/auth/<name>.ts`, register in `src/index.ts`

## Critical patterns

**Always use spread, never destructure request bodies.** Providers like Copilot pass `reasoning_opaque` and other opaque fields that must survive round-trips. Destructuring silently strips unknown fields.

```typescript
// ✓ correct — preserves all fields
{ ...req, model: upstreamId }

// ✗ wrong — strips reasoning_opaque and other unknown fields
const { model, messages, ...rest } = req
```

**Fire-and-forget for analytics** — `usageStore.record()` and routing callbacks are not awaited on the hot path.

**Tests use in-memory SQLite** — no real credentials needed; mock `fetch` for provider calls.

## Environment variables

- `PORT` — server port (default: 3000)
- `KEYROUTER_NO_OPEN=1` — skip auto-opening dashboard on start

## Configuration

`router.json` (see `router.example.json` for full schema). Hot-reloaded on change. The dashboard at `/dashboard` can edit it via API; direct JSON edits also work.
