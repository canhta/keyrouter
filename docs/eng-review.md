# Engineering Plan Review — keyrouter

**Date:** 2026-03-17
**Mode:** BIG CHANGE
**Reviewer:** Claude (plan-eng-review skill)
**Input:** CEO review decisions + architecture_modules.md + implementation_plan.md

---

## Decisions Made

| # | Decision | Choice |
|---|---|---|
| 1 | CLI entry point | Separate `bin/keyrouter.ts` dispatching to server vs auth subcommand |
| 2 | RequestConductor | Inline retry loop in handler; extract if a second handler needs it |
| 3 | Shared types | One `src/types.ts` file; remove all per-module `types.ts` files |
| 4 | RoutingStrategy API | `selectAccounts()` plural — returns sorted `AccountEntry[]` |
| 5 | Test structure | `tests/unit/` + `tests/integration/` with `bun test` |
| 6 | Credential caching | No cache; always read from SQLite (WAL, <1ms) |

---

## Updated Folder Structure

```
local-router/
├── bin/
│   └── keyrouter.ts              # Entry point: 'start' | 'auth <provider>'
├── src/
│   ├── index.ts                  # Hono app + startup (called by bin/keyrouter.ts)
│   ├── config.ts                 # Load + hot-reload router.json (fs.watch + JSON.parse guard)
│   ├── types.ts                  # ALL shared interfaces (Credential, ModelEntry, etc.)
│   ├── db/
│   │   └── migrations.ts         # Schema versioning + CREATE TABLE statements
│   ├── auth/
│   │   ├── store.ts              # CredentialStore: resolve() with in-flight promise dedup
│   │   ├── copilot.ts            # CopilotOAuth: device flow + refresh
│   │   ├── codex.ts              # CodexOAuth: PKCE flow + refresh (phase 2)
│   │   └── apikey.ts             # ApiKeyCredential: static, no refresh
│   ├── providers/
│   │   ├── index.ts              # Provider registry: id → ProviderDefinition
│   │   ├── copilot.ts            # requestHeaders() incl. Editor-Version, Copilot-Integration-Id
│   │   ├── openai.ts
│   │   └── openrouter.ts
│   ├── registry/
│   │   └── index.ts              # ModelRegistry: lookup(modelId) + hot-swap
│   ├── translation/
│   │   ├── stream.ts             # UsageSynthesisTransform (SSE parse + synthesis + [DONE])
│   │   └── openai-responses.ts   # Responses API translator (phase 2)
│   ├── routing/
│   │   ├── strategy.ts           # selectAccounts() sorted list: unlocked first
│   │   └── lock-store.ts         # SQLite model lock backoff (30s→1m→5m→30m)
│   ├── handlers/
│   │   ├── chat-completions.ts   # POST /v1/chat/completions (inline retry loop)
│   │   ├── models.ts             # GET /v1/models
│   │   └── status.ts             # GET /v1/status
│   ├── usage/
│   │   └── store.ts              # UsageStore.record() — fire-and-forget async
│   └── cli/
│       └── auth.ts               # runAuthFlow(provider): device flow + store token
├── tests/
│   ├── unit/
│   │   ├── registry.test.ts      # lookup hit/miss
│   │   ├── routing.test.ts       # selectAccounts ordering, lock backoff sequence
│   │   ├── credential-store.test.ts  # fresh/expiring/in-flight/revoked paths
│   │   └── stream.test.ts        # usage synthesis, malformed chunk skipping
│   └── integration/
│       ├── chat-completions.test.ts  # mock provider, full SSE + non-streaming path
│       └── auth-middleware.test.ts   # valid key / invalid key / no key
├── router.example.json           # Config template for new users
├── router.json                   # Actual config (gitignored)
├── data/                         # SQLite database (gitignored)
├── .gitignore                    # router.json? No — users commit their config. data/ yes.
├── package.json                  # engines: { bun: ">=1.0.0" }
└── tsconfig.json
```

---

## Section 1: Architecture Review

### Obvious fixes applied

**1. Providers naming collision fixed:** `providers/registry.ts` → `providers/index.ts`

**2. AbortController propagation:** Must pass `c.req.raw.signal` to upstream `fetch()`:
```typescript
const response = await fetch(providerUrl, {
  method: 'POST',
  headers: provider.requestHeaders(cred),
  body: JSON.stringify(upstreamBody),
  signal: c.req.raw.signal,  // ← REQUIRED: cancels upstream on client disconnect
})
```

**3. Hot-reload JSON.parse guard:**
```typescript
// config.ts
fs.watch('router.json', () => {
  try {
    const raw = fs.readFileSync('router.json', 'utf8')
    const config = JSON.parse(raw)  // may throw on partial write
    modelRegistry.swap(config)      // atomic ref swap
    console.log('[keyrouter] config reloaded')
  } catch {
    // partial write — next fs.watch event will catch the complete file
  }
})
```

### Data flow (hot path)

```
 HTTP Request (Hono)
       │
       │ c.req.raw.signal ──────────────────────────────────┐
       ▼                                                     │
 [Auth Middleware]                                           │
 timingSafeEqual(incoming, server.apiKey) if configured     │
       │                                                     │
       ▼                                                     │
 [ChatHandler — handlers/chat-completions.ts]               │
       │                                                     │
       ├─ parseBody() + size limit check → 413 if over       │
       │                                                     │
       ├─ ModelRegistry.lookup(model)                        │
       │     null → 404 OpenAI error format                  │
       │                                                     │
       ├─ RoutingStrategy.selectAccounts(model.id, accounts) │
       │     [] → 503 + Retry-After                          │
       │                                                     │
       ├─ for account of accounts:                           │
       │     CredentialStore.resolve(providerId, accountId)  │
       │       CredentialNotFound → 503 "run keyrouter auth" │
       │       OAuthRevokedError → 503 "token revoked"       │
       │                                                     │
       │     ProviderDefinition.requestHeaders(cred)         │
       │                                                     │
       │     fetch(url, { signal, headers, body })◄──────────┘
       │       timeout/5xx → onError() + continue
       │       429 → onError() + continue
       │       401 → refresh → if refresh 401: OAuthRevokedError
       │       HTML body → JSON.parse catch → onError() + continue
       │       success → break retry loop
       │
       ▼
 [UsageSynthesisTransform — translation/stream.ts]
       │
       ├─ Parse SSE line by line
       │     try/catch: malformed line → log.warn + skip
       │
       ├─ Detect usage chunk → usageEmitted = true
       │
       ├─ On [DONE]: if !usageEmitted → yield synthesized usage chunk
       │
       └─ yield "data: [DONE]\n\n"
             │
             ▼
       usageStore.record(record).catch(warn)  // fire-and-forget
       routing.onSuccess(accountId, modelId)
             │
             ▼
       return Hono streaming response
```

---

## Section 2: Code Quality Review

### Key interface changes from this review

**RoutingStrategy (updated):**
```typescript
interface RoutingStrategy {
  // Returns accounts sorted: unlocked (round-robin) first, locked (by expiry) last
  // Returns [] if all accounts locked
  selectAccounts(modelId: string, accounts: AccountEntry[]): AccountEntry[]
  onSuccess(accountId: string, modelId: string): void
  onError(accountId: string, modelId: string, statusCode: number): void
}
```

**src/types.ts (consolidated — all interfaces in one file):**
```typescript
// Credential & Auth
export interface Credential { ... }
export interface OAuthProvider { ... }
export interface CredentialStore { ... }

// Provider
export interface ProviderDefinition { ... }  // requestHeaders() not authHeader()

// Model Registry
export interface ModelEntry { ... }
export interface RouterConfig { ... }

// Routing
export interface AccountEntry { ... }
export interface RoutingStrategy { ... }

// Translation
export interface Translator { ... }
export interface StreamState { ... }

// Usage
export interface UsageRecord { ... }
```

**CRITICAL comment on CanonicalChatRequest:**
```typescript
// CRITICAL: Never destructure this type. Always spread:
//   ✓ { ...req, model: resolved }
//   ✗ const { model, messages } = req  ← strips unknown fields, breaks reasoning_opaque
export interface CanonicalChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  [key: string]: unknown
}
```

### Files requiring inline ASCII diagram comments

| File | Diagram type |
|------|-------------|
| `src/translation/stream.ts` | SSE pipeline: line splitting → JSON parse → usage detection → synthesis → [DONE] |
| `src/routing/strategy.ts` | selectAccounts() ordering logic |
| `src/auth/store.ts` | resolve() state machine: fresh / expiring / in-flight / revoked |
| `src/handlers/chat-completions.ts` | Request flow and retry loop |
| `src/db/migrations.ts` | Schema tables and relationships |

---

## Section 3: Test Review

### Phase 1 done-criteria (must pass before Phase 1 is complete)

**Unit tests (`tests/unit/`):**
- `registry.test.ts`: lookup hit returns ModelEntry, lookup miss returns null
- `routing.test.ts`: selectAccounts returns unlocked first, lock backoff sequence (30s→60s→300s→1800s)
- `credential-store.test.ts`: fresh credential returned as-is, expiring triggers refresh, concurrent calls share in-flight promise, revoked 401 throws OAuthRevokedError
- `stream.test.ts`: missing usage chunk → synthesized before [DONE], malformed SSE line → skipped, stream continues

**Integration tests (`tests/integration/`):**
- `chat-completions.test.ts`: mock provider, full SSE path → chunks arrive + usage present; 429 → retry next account; HTML body → 503
- `auth-middleware.test.ts`: valid key → 200, invalid key → 401, no key configured → passes through

### Full test matrix

| Test | Type | Priority |
|------|------|----------|
| Model lookup hit/miss | Unit | Phase 1 |
| selectAccounts ordering | Unit | Phase 1 |
| Lock backoff sequence | Unit | Phase 1 |
| Credential: fresh/expiring/in-flight/revoked | Unit | Phase 1 |
| Usage synthesis: present/absent | Unit | Phase 1 |
| Malformed SSE chunk → skip | Unit | Phase 1 |
| Full SSE streaming path | Integration | Phase 1 |
| Non-streaming (stream:false) | Integration | Phase 1 |
| 429 → lock → fallback | Integration | Phase 1 |
| HTML body → 503 | Unit | Phase 1 |
| Auth middleware variants | Integration | Phase 1 |
| Startup with missing router.json | Unit | Phase 1 |
| Hot-reload valid JSON | Unit | Phase 2 |
| Hot-reload partial write (guard) | Unit | Phase 2 |
| Device flow stores token | Unit | Phase 3 |
| Device code expired | Unit | Phase 3 |
| GET /v1/status response shape | Integration | Phase 1 |
| fetch timeout → retry | Integration | Phase 4 |
| Client disconnect → upstream abort | Integration | Phase 4 |

---

## Section 4: Performance Review

- **WAL mode**: `db.exec('PRAGMA journal_mode=WAL')` at startup — required
- **Usage writes**: Fire-and-forget, never awaited in hot path
- **Credential reads**: No cache; SQLite WAL read is <1ms; acceptable for local tool
- **No N+1 issues**: All queries are single-row primary key lookups
- **Bun fetch**: Keep-alive by default; no extra pooling needed

---

## Failure Modes

```
CODEPATH                    | FAILURE MODE              | TEST?  | HANDLED? | USER SEES
----------------------------|---------------------------|--------|----------|-----------------
CredentialStore.resolve()   | No credential (first run) | Yes ✓  | Yes ✓    | 503 + auth instructions
                            | Refresh 401 (revoked)     | Yes ✓  | Yes ✓    | 503 + re-auth message
                            | Concurrent refresh race   | Yes ✓  | Yes ✓    | Transparent (dedup)
handler retry loop          | All accounts locked       | Yes ✓  | Yes ✓    | 503 + Retry-After
                            | Provider returns HTML      | Yes ✓  | Yes ✓    | 503 "unavailable"
                            | fetch timeout             | No ←   | Yes ✓    | 503 (after retry)
SSE TransformStream         | Malformed SSE chunk       | Yes ✓  | Yes ✓    | Stream continues
                            | Upstream drops mid-stream | No ←   | Partial  | Stream ends abruptly
UsageSynthesisTransform     | Missing usage chunk       | Yes ✓  | Yes ✓    | Synthesized before [DONE]
hot-reload fs.watch         | Partial write (bad JSON)  | Yes ✓  | Yes ✓    | Old config stays active
bin/keyrouter auth          | Device code expires       | No ←   | Yes ✓    | Error message printed
```

**Critical gaps: 0.** Three items with no test but existing error handling — add in Phase 4 (hardening).

---

## Completion Summary

- **Step 0:** Scope Challenge → BIG CHANGE selected
- **Architecture Review:** 2 decisions + 3 obvious fixes
- **Code Quality Review:** 2 decisions (types consolidation, RoutingStrategy API) + 3 obvious fixes
- **Test Review:** Diagram produced (20 items), 6 unit + 6 integration tests required for Phase 1 done-criteria
- **Performance Review:** 1 decision (no credential caching) + 2 obvious fixes (WAL, fire-and-forget usage)
- **NOT in scope:** 8 items documented
- **What already exists:** 5 reference code mappings
- **TODOS.md:** 3 items added (`keyrouter doctor` P2, Claude Code OAuth P2, web dashboard P3)
- **Failure modes:** 0 critical gaps; 3 items lacking tests (add in Phase 4)
- **Unresolved decisions:** None

---

## Summary of All Plan Changes to Apply

Apply these to `implementation_plan.md` and `architecture_modules.md` before implementing:

1. Add `bin/keyrouter.ts` entry point to folder structure
2. Remove all per-module `types.ts` files → consolidate into `src/types.ts`
3. Rename `providers/registry.ts` → `providers/index.ts`
4. Change `RoutingStrategy.selectAccount()` → `selectAccounts()` returning `AccountEntry[]`
5. Add `tests/unit/` + `tests/integration/` to folder structure
6. Add `router.example.json` to folder structure
7. Add `AbortController` propagation note to Phase 1 step 4
8. Add `fs.watch` + JSON.parse guard to hot-reload implementation note
9. Add inline ASCII diagram requirement to `stream.ts`, `strategy.ts`, `store.ts`, `chat-completions.ts`
10. Add `PRAGMA journal_mode=WAL` to Phase 1 DB setup step
11. Add Phase 1 done-criteria: 6 unit tests + 6 integration tests passing
12. Add `.gitignore` note: `data/` and `router.db` (but NOT `router.json` — users may want to commit their config)
