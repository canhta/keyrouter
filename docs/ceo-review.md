# CEO Plan Review — keyrouter

**Date:** 2026-03-17
**Mode:** EXPANSION
**Reviewer:** Claude (plan-ceo-review skill)

---

## Decisions Made

| Decision | Choice |
|---|---|
| Runtime | Bun (native TypeScript, bun:sqlite, no better-sqlite3) |
| Incoming auth | Optional apiKey in router.json, off by default, localhost-only |
| Provider headers interface | `requestHeaders()` not `authHeader()` |
| Concurrent refresh race | In-flight promise cache in CredentialStore |
| Non-streaming requests | Handle both stream:true and stream:false from day 1 |
| SSE architecture | Transform-stream-first always (no direct pipe) |
| Testing | bun test + mock providers |
| Status endpoint | `GET /v1/status` — in MVP |
| Hot-reload config | `fs.watch('router.json')` — in MVP |
| Auth CLI | `keyrouter auth <provider>` subcommand — in MVP |
| Startup banner | Yes — in MVP |

---

## PRE-REVIEW SYSTEM AUDIT

**Current state:** Pure planning phase. `keyrouter/` has `.git` and spike docs only — zero lines of code.

**Existing reference code available locally:**
- `9router/` — JS port (GitHub Copilot auth, streaming, tool calls, model locks)
- `CLIProxyAPI/` — Go original (Codex OAuth, auth conductor, routing strategies)
- `portkey/`, `opencode/` — additional reference implementations

**Key risks already well-researched:** Spike docs are thorough. H1–H5 hypotheses tested. Root causes mapped. OAuth constants confirmed.

---

## Step 0: Nuclear Scope Challenge

### 0A. Premise Challenge

The problem is real and unsolved by existing tools: **subscription OAuth providers (Copilot, Codex) cannot work with API-key-only gateways.** Portkey can't help. OpenRouter can't help. Genuine gap.

One premise challenged: `router.json` with no hot-reload. Hot-reload decided: **add to MVP** (20 lines, high QoL).

### 0B. Existing Code Leverage

| Sub-problem | Existing code | Reused? |
|---|---|---|
| Copilot device OAuth | `9router/src/sse/services/auth.js` | Yes — direct TS port |
| Codex PKCE OAuth | `CLIProxyAPI/sdk/auth/codex.go` + `codex_device.go` | Yes — translated |
| Model lock backoff | `9router` SQLite pattern (30s→1m→5m→30m) | Yes — direct port |
| Conductor logic | `CLIProxyAPI/sdk/cliproxy/auth/conductor.go` | Yes — pattern |
| SSE streaming | `9router/open-sse/handlers/chatCore/streamingHandler.js` | Reference |
| Tool call passthrough | Plan's own analysis (never rewrite IDs) | No porting needed |

### 0C. Dream State

```
THIS PLAN (revised)           12-MONTH IDEAL               GAP
Copilot + Codex OAuth    →    + Claude Code, Gemini CLI    2 more providers (TODO P2)
OpenCode compat              Same + Cursor, Continue       OOTB no extra work
bun:sqlite storage           Same                          ✓
GET /v1/status               + Full web dashboard          TODO P3
keyrouter auth <provider>    + keyrouter doctor            TODO P2
Hot-reload router.json       Same                          ✓ (in MVP)
bun test suite               + CI/CD integration           Manual for now
```

### 0D. 10x Check (EXPANSION)

The 10x version for 2x effort:
1. All subscription providers: Copilot + Codex + Claude Code + Gemini CLI — same interface, more implementations
2. `GET /v1/status` — decided: **in MVP**
3. First-run wizard: `keyrouter init` → device flow → writes `router.json`
4. Hot-reload config — decided: **in MVP**
5. `keyrouter doctor` — decided: **TODOS.md P2**

### 0E. Temporal Interrogation

**HOUR 1 (skeleton):** Runtime = Bun. Incoming auth = optional. First-run: create `router.json` template if missing, print instructions.

**HOUR 2–3 (credential store):** Single shared `bun:sqlite` Database instance. Schema versioning via `schema_version` table. SQLite WAL mode on init. DB file permissions: 0o600.

**HOUR 3–4 (Copilot OAuth wiring):** `requestHeaders()` interface (not `authHeader()`). In-flight refresh promise cache. CLI subcommand for device flow trigger.

**HOUR 4–5 (concurrent requests):** Transform-stream-first (not pipe). Handle `stream: false`. Request body size limit via Hono middleware.

**HOUR 6+ (polish):** JSON.parse guard on provider responses. SSE chunk try/catch. `Retry-After` header on all-accounts-locked 503.

---

## Section 1: Architecture Review

### System Diagram

```
Client (OpenCode / AI SDK / Cursor)
        │  POST /v1/chat/completions   Authorization: Bearer <optional-key>
        │  GET  /v1/models
        │  GET  /v1/status
        ▼
┌─────────────────────────────────────────────────────────────┐
│                     Hono app (Bun)                          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Middleware stack                                    │   │
│  │  1. Auth guard (optional apiKey check)              │   │
│  │  2. Request ID injection                            │   │
│  │  3. Request logger                                  │   │
│  │  4. Body size limit                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                   │
│  ┌──────────────┐        │        ┌────────────────────┐   │
│  │ ModelRegistry│◀───────┤        │  RoutingStrategy   │   │
│  │  loader.ts   │        │        │  (round-robin +    │   │
│  │  + fs.watch  │        ▼        │   lock check)      │   │
│  └──────────────┘  RequestConductor    │               │   │
│                    .execute()     │    │ selectAccount()│   │
│  ┌──────────────┐        │        ▼    ▼               │   │
│  │CredentialStore│◀──────┤   ┌──────────────────────┐ │   │
│  │  bun:sqlite  │        │   │  OAuthProvider or    │ │   │
│  │  + in-flight │        │   │  ApiKeyCredential    │ │   │
│  │  dedup cache │        │   └──────────────────────┘ │   │
│  └──────────────┘        │                             │   │
│                          │ fetch() with requestHeaders()   │
│  ┌──────────────┐        ▼                             │   │
│  │ LockStore    │  TransformStream                     │   │
│  │  bun:sqlite  │  (usage synthesis + passthrough)     │   │
│  └──────────────┘        │                             │   │
│                          │                             │   │
│  ┌──────────────┐        ▼                             │   │
│  │ UsageStore   │  Stream to client                    │   │
│  │  bun:sqlite  │  (or buffer for non-streaming)       │   │
│  └──────────────┘                                      │   │
└─────────────────────────────────────────────────────────────┘
        │
        ▼ upstream requests
┌──────────────────────────────────────────────────────────┐
│  Copilot         │  Codex           │  API-key providers │
│  (OAuth bearer)  │  (OAuth PKCE)    │  (OpenAI, etc.)    │
│                  │                  │                     │
│  requestHeaders: │  requestHeaders: │  requestHeaders:    │
│  Authorization   │  Authorization   │  Authorization      │
│  Editor-Version  │  (standard only) │  (standard only)    │
│  Copilot-Int-Id  │                  │                     │
└──────────────────────────────────────────────────────────┘
```

### Critical Fixes to Architecture

**FIX 1 — ProviderDefinition interface: `authHeader` → `requestHeaders`**

Copilot requires headers beyond Authorization (`Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`). Without these, all Copilot requests return 403. The interface must return ALL upstream headers.

```typescript
interface ProviderDefinition {
  id: string
  baseURL: string
  // Returns ALL headers for upstream requests
  // (auth + any provider-specific required headers)
  requestHeaders(cred: Credential): Record<string, string>
  endpoint: { chatCompletions: string; responses?: string }
}
```

**FIX 2 — CredentialStore: in-flight refresh promise cache**

```typescript
class CredentialStore {
  private refreshing = new Map<string, Promise<Credential>>()

  async get(providerId: string, accountId: string): Promise<Credential> {
    const cred = this.db.getCred(providerId, accountId)
    if (!this.isExpiringSoon(cred)) return cred

    const key = `${providerId}:${accountId}`
    if (!this.refreshing.has(key)) {
      const p = this.doRefresh(providerId, accountId)
        .finally(() => this.refreshing.delete(key))
      this.refreshing.set(key, p)
    }
    return this.refreshing.get(key)!
  }
}
```

**FIX 3 — Transform-stream-first (no direct pipe)**

Phase 1 plan says "pipe upstream response directly." R4 fix requires intercepting the stream. These are incompatible. Commit to transform-stream-first: always wrap SSE through a `TransformStream` that watches for usage chunk, synthesizes one if absent, then yields `[DONE]`.

**FIX 4 — RequestConductor separation**

Separate routing/retry concern from the handler:
```typescript
class RequestConductor {
  async execute(modelId: string, body: unknown): AsyncIterable<string>
}
```
Makes retry/fallback logic independently testable.

**ADDITION — `GET /v1/status` endpoint**
```json
{
  "providers": [
    { "id": "copilot", "accounts": [{ "id": "default", "tokenExpiry": "...", "locked": false }] }
  ],
  "models": ["gpt-4o", "claude-3-7-sonnet"],
  "uptime": 3600
}
```

---

## Section 2: Error & Rescue Map

```
METHOD               | EXCEPTION              | RESCUED? | ACTION              | USER SEES
---------------------|------------------------|----------|---------------------|-----------------
CredentialStore.get  | CredentialNotFound     | Y        | 503                 | "Run keyrouter auth <provider>"
                     | OAuthRevokedError      | Y        | Clear token, 503    | "Token revoked. Re-run device flow"
                     | RefreshError           | Y        | Try next acct/503   | Transparent/503
                     | bun:sqlite error       | Y        | 503 + log.error     | "Internal error"
CopilotOAuth         | DeviceCodeExpired      | Y        | 503                 | "Device auth expired. Run keyrouter auth again"
  .fetchToken        | fetch timeout          | Y        | Retry 1x then throw | "Provider unavailable"
  .refreshToken      | 401 revoked            | Y        | OAuthRevokedError   | "Token revoked"
provider fetch       | 429                    | Y        | Lock + retry loop   | Transparent
                     | 401                    | Y        | Refresh or revoke   | Transparent/503
                     | 5xx                    | Y        | Lock + retry loop   | Transparent/502
                     | HTML response (WAF)    | FIXED    | JSON.parse try/catch| "Provider unavailable"
                     | SSE malformed chunk    | FIXED    | try/catch + skip    | Stream continues
                     | Connection drop        | Y        | ReadableStream err  | Stream ends
ModelRegistry.lookup | Not found              | Y        | 404 OpenAI format   | {"error": {"message": "Model not found"}}
RoutingStrategy      | All accounts locked    | Y        | 503 + Retry-After   | "No accounts available"
Request body parse   | Body too large         | FIXED    | Hono body limit mw  | 413
```

**CRITICAL: 401 from provider must distinguish "expired" from "revoked":**
- `expired` → attempt refresh → if refresh succeeds, retry request
- `revoked` (refresh 401) → `OAuthRevokedError` → clear stored token → 503 with re-auth instructions

---

## Section 3: Security & Threat Model

```
THREAT                        | LIKELIHOOD | IMPACT | MITIGATION
------------------------------|------------|--------|------------------
router.db world-readable      | High       | High   | Set 0o600 on db file at startup
router.json API keys plaintext| High       | Medium | Document; .gitignore entry
API key timing attack         | Low        | Low    | Use crypto.timingSafeEqual()
Token reuse if db stolen      | Medium     | High   | 0o600 file permissions
SSRF via baseURL in config    | Low        | Medium | Acceptable (local, user-controlled)
```

**Actions required in implementation:**
1. `fs.chmodSync('data/router.db', 0o600)` immediately after creating/opening
2. `timingSafeEqual` for incoming API key validation
3. Add `data/` to `.gitignore`
4. Document ToS risk of Copilot account rotation in README (plan R6 already notes this)

---

## Section 4: Data Flow & Interaction Edge Cases

### SSE Data Flow

```
Client request
     │
     ▼
[VALIDATE body size] ── too large ───────────────► 413
     │
     ▼
[AUTH GUARD] ── missing/invalid key ─────────────► 401
     │
     ▼
[VALIDATE model exists] ── not found ────────────► 404 OpenAI format
     │
     ▼
[SELECT account] ── all locked ──────────────────► 503 + Retry-After
     │
     ▼
[GET credential] ── not authed ──────────────────► 503 "Run keyrouter auth"
                 ── refresh fail ─────────────────► 503
     │
     ▼
[fetch() with AbortController (timeout)]
     │  timeout ──► lock account, try next account in retry loop
     │  5xx ──────► lock account, try next account
     │  401 ──────► refresh attempt → revoke path if refresh 401
     │  429 ──────► lock account, try next account
     │
     ▼
[TransformStream: SSE line parser]
     │  malformed chunk ── try/catch → log.warn + skip chunk, continue
     │
     ▼
[Watch for usage chunk → usageEmitted = true]
     │
     ▼
[Synthesize usage if !usageEmitted before [DONE]]
     ▼
[yield data: [DONE]]
     │
     ▼
[Record UsageRecord to SQLite] ── write fail: log.warn + continue
     ▼
[onSuccess() → clear any lock on this account+model]
```

### Edge Cases

```
INTERACTION           | EDGE CASE                    | HANDLED? | FIX
----------------------|------------------------------|----------|-----------------
Stream request        | Client disconnects (Ctrl+C)  | YES      | request.signal → AbortController → cancel upstream fetch
                      | Upstream drops mid-stream    | YES      | ReadableStream error → log + close
Credential store      | Two requests, expired token  | YES      | In-flight promise cache
Model lookup          | Unknown model string         | YES      | 404 OpenAI error format
All accounts locked   | No accounts available        | YES      | 503 + Retry-After header
Non-streaming         | stream: false or absent      | YES      | Buffer full response, return JSON
Request body          | Too large (100KB+ history)   | YES      | Hono body size middleware
router.json           | Changed during request       | ACCEPTED | Atomic ref swap on hot-reload; in-flight requests complete
```

---

## Section 5: Code Quality

**Key patterns to enforce:**

1. **Single Database instance** — pass to all stores via constructor, never open multiple connections
2. **Never destructure messages** — always spread: `{ ...body, model: resolvedModel }` — never `const { model, messages } = body` (strips unknown fields, breaks `reasoning_opaque`)
3. **OpenAI error format everywhere**:
   ```json
   { "error": { "message": "...", "type": "...", "code": "..." } }
   ```
4. **`CredentialStore.resolve()`** not `.get()` — name signals it fetches + refreshes
5. **Cyclomatic complexity**: Chat handler should delegate to `RequestConductor.execute()` — handler itself should be <20 lines

---

## Section 6: Test Plan

```
NEW UX FLOWS:
  - Device auth flow: user sees URL+code, authorizes in browser
  - First request after auth: token fetched, routes correctly
  - Rate-limited provider: falls over to next account silently
  - All accounts locked: 503 with Retry-After

NEW DATA FLOWS:
  - router.json → ModelRegistry → model lookup
  - client request → credential → provider → SSE transform → client
  - OAuth device flow → CredentialStore (SQLite persist)
  - 429 response → LockStore → RoutingStrategy (skip locked)
  - stream end → UsageStore (record)

NEW CODEPATHS:
  - incoming auth guard (with/without apiKey)
  - model not found → 404
  - account selection with locked/unlocked states
  - token expiry + refresh (auto-triggered)
  - token revocation path (401 → re-auth)
  - usage synthesis before [DONE]
  - non-streaming response buffering
  - concurrent refresh dedup
  - client disconnect → upstream abort

NEW INTEGRATIONS:
  - GitHub Copilot API (OAuth + chat completions)
  - OpenAI API (API key)
  - bun:sqlite
```

**Required tests (bun test):**

| Test | Type | Description |
|------|------|-------------|
| Model lookup hit | Unit | Returns ModelEntry for known model |
| Model lookup miss | Unit | Returns null for unknown model |
| Credential fetch — fresh | Unit | Returns stored cred without refresh |
| Credential fetch — expired | Unit | Triggers refresh when expiringSoon |
| Concurrent refresh dedup | Unit | Does NOT double-refresh on concurrent requests |
| Lock store — backoff sequence | Unit | Returns 30s→60s→300s→1800s |
| SSE passthrough — usage present | Integration | Mock provider; verify usage forwarded |
| SSE passthrough — usage absent | Integration | Mock provider; verify synthesis |
| 429 → lock → fallback | Integration | Mock 429; verify retry with next account |
| 401 revoked → clear + 503 | Integration | Verify token cleared, correct error response |
| Malformed SSE chunk | Unit | Chunk skipped, stream continues |
| Non-streaming request | Integration | stream:false → JSON response |
| Client disconnect → abort | Unit | request.signal aborts upstream fetch |
| HTML provider response | Unit | JSON.parse catch → 503 |

---

## Section 7: Performance

- **WAL mode**: `db.exec('PRAGMA journal_mode=WAL')` at startup — prevents reader/writer contention
- 3 SQLite ops/request (credential, lock check, usage write) — acceptable at single-user scale
- No N+1 — all queries are single-row primary key lookups
- Bun `fetch` uses keep-alive by default — no extra pooling needed
- No caching needed for credentials — 5-min expiry buffer is sufficient

---

## Section 8: Observability

**Logging format:**
```
[keyrouter] [INFO]  2026-03-17T10:00:00Z reqId=abc model=gpt-4o provider=copilot account=default → 200 (1234ms)
[keyrouter] [WARN]  reqId=abc provider=copilot account=default 429 → locked until +30s, trying next
[keyrouter] [ERROR] reqId=abc provider=copilot account=default refresh failed: OAuthRevokedError
```

**Observability endpoints:**
- `GET /v1/status` — provider health, token expiry, active locks, loaded models
- `GET /v1/models` — configured model list

**Debuggability at 3 weeks post-bug:**
With usage table + request logs: reconstruct model called, provider, account, status code, latency, error message. Sufficient for local tool.

---

## Section 9: Deployment & Rollout

**First run:**
1. Check `router.json` exists — if not, print instructions + exit
2. Create `data/` directory if missing
3. Open `bun:sqlite` database (creates file if absent)
4. Set db file permissions to 0o600
5. Enable WAL mode: `PRAGMA journal_mode=WAL`
6. Run schema migrations
7. Start Hono server
8. Print startup banner

**Schema migrations in `src/db/migrations.ts`:**
```sql
-- v1
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS credentials (provider_id TEXT, account_id TEXT, token TEXT, expires_at INTEGER, refresh_token TEXT, PRIMARY KEY (provider_id, account_id));
CREATE TABLE IF NOT EXISTS model_locks (account_id TEXT, model_id TEXT, locked_until INTEGER, attempt_count INTEGER, PRIMARY KEY (account_id, model_id));
CREATE TABLE IF NOT EXISTS usage (ts INTEGER, model_id TEXT, provider_id TEXT, account_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, status_code INTEGER, error TEXT);
```

**Port conflict:** Catch `EADDRINUSE`, print: `"Port 3000 is in use. Set server.port in router.json to change it."` and exit 1.

**Rollback:** Local SQLite + local files. Rollback = git checkout + delete data/router.db if schema changed.

---

## Section 10: Long-Term Trajectory

**Reversibility: 5/5** — local tool, no shared infra, trivially reversible.

**Technical debt:** Zero, assuming transform-stream-first decision is honored. The one risk was "pipe directly" in Phase 1 — eliminated.

**Extension points:**
- New OAuth provider: implement `OAuthProvider` interface, add to `providers/`, register in config
- New format translator: implement `Translator` interface — clean extensibility
- Claude Code OAuth: same device flow pattern, `CLIProxyAPI/internal/auth/antigravity/` is the reference

**Platform potential:** `RequestConductor` + `CredentialStore` could be extracted as a library — "OAuth-aware routing for Hono." Interesting open-source contribution.

---

## NOT in Scope

| Item | Rationale |
|------|-----------|
| Web dashboard | Status endpoint covers observability at MVP |
| Semantic/Redis caching | No performance need at single-user scale |
| Format translation (Anthropic, Gemini) | Only OpenAI ↔ OpenAI needed for OpenCode |
| gRPC Connect (Cursor), AWS binary (Kiro) | Out of OpenCode compat scope |
| Multi-machine / network-exposed deployment | Local-only for MVP |
| Background token pre-refresh | On-demand refresh is sufficient |
| Model registry background updater | Config file is source of truth |
| `keyrouter doctor` command | In TODOS.md P2 |

---

## TODOS.md Entries to Add

### TODO: `keyrouter doctor` command
**What:** CLI subcommand that validates router.json, tests each provider connection, and reports token freshness.
**Why:** Saves hours of debugging on onboarding and after token expiry. Common "why isn't this working" questions answered in one command.
**Pros:** Huge onboarding improvement; useful for CI health checks.
**Cons:** 1 hour of work; covers same ground as status endpoint + auth CLI.
**Context:** After MVP ships with `keyrouter auth` and `GET /v1/status`, the doctor command is the natural polish step. Should check: config parses, db exists, tokens not expired, provider reachable.
**Effort:** M | **Priority:** P2 | **Depends on:** auth CLI, status endpoint

### TODO: Claude Code OAuth
**What:** `OAuthProvider` implementation for Anthropic's Claude Code CLI tool.
**Why:** Claude Code is a primary AI coding tool; subscription OAuth follows same pattern as Copilot/Codex.
**Pros:** Covers another major subscription provider; reference implementation in CLIProxyAPI.
**Cons:** Medium effort; requires testing with real Claude Code subscription.
**Context:** Reference: `CLIProxyAPI/internal/auth/antigravity/auth.go`. Same `OAuthProvider` interface as Copilot/Codex implementations. Token endpoint: `https://api.anthropic.com/v1/oauth/token`.
**Effort:** M | **Priority:** P2 | **Depends on:** core OAuth pattern stable

### TODO: Web status dashboard
**What:** Minimal HTML page at `GET /` powered by `/v1/status` JSON endpoint. Shows provider health, token expiry countdowns, recent usage, locked models.
**Why:** Visual health check without curl. Nice for monitoring while developing.
**Pros:** Zero new data model work — reads existing SQLite + status endpoint.
**Cons:** Large effort relative to value; the status endpoint JSON covers most needs.
**Context:** Build after `/v1/status` endpoint is stable. Vanilla HTML + a tiny amount of JS calling the endpoint. No frontend framework needed.
**Effort:** L | **Priority:** P3 | **Depends on:** /v1/status endpoint

---

## Updated Plan: Changes to Apply

Apply these to the spike docs before implementation:

1. **Replace `npm` with `bun`** everywhere in implementation plan. Drop `better-sqlite3`.
2. **Replace `authHeader()` with `requestHeaders()`** in architecture_modules.md — ProviderDefinition interface, all provider implementations.
3. **Add in-flight promise cache** to CredentialStore description in architecture_modules.md.
4. **Change Phase 1 step 4** from "SSE streaming passthrough (pipe upstream response directly)" to "SSE streaming passthrough (TransformStream wrapper: usage synthesis + [DONE] termination)."
5. **Add non-streaming path** to Phase 1 scope.
6. **Add `GET /v1/status`** to API surface in architecture_modules.md.
7. **Add `keyrouter auth <provider>` CLI subcommand** as a Phase 1 step.
8. **Add `bun test` setup** with mock providers as Phase 1 step.
9. **Add startup banner** to Phase 1.
10. **Add hot-reload** (`fs.watch('router.json')`) to Phase 2.
11. **Add `RequestConductor`** class to routing/ module map.
12. **Add shared Database instance pattern** to architecture notes.
13. **Add OpenAI error format requirement** to all error paths.
14. **Add security checklist** (db 0o600, timingSafeEqual, .gitignore for data/).
15. **Add SQLite WAL mode** to Phase 1 setup step.
16. **Add schema_version migration table** to Phase 1 SQLite setup.
