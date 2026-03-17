# keyrouter — Architecture


---

## Goal

A lightweight self-hosted AI router in TypeScript/Bun that:
- Handles subscription-backed provider OAuth (GitHub Copilot, OpenAI Codex) — not just API keys
- Exposes a clean `/v1/chat/completions` endpoint for downstream clients
- Provides fallback, account rotation, and per-model routing
- Is fully compatible with OpenCode (`@ai-sdk/openai-compatible`) and Vercel AI SDK v5

**Why it exists:** Subscription-backed providers (Copilot, Codex) require OAuth device flows managed by the router itself. Standard API-key-only gateways (Portkey, OpenRouter) cannot handle this.

---

## Runtime

- **Bun** (not Node) — native TypeScript, `bun:sqlite` built-in, fast startup
- No `better-sqlite3`, no `tsx`, no `ts-node`
- Entry: `bun run bin/keyrouter.ts [start|auth <provider>]`

---

## System Overview

```
Client (OpenCode / Cursor / Continue / any OpenAI-compatible tool)
        │
        │  POST /v1/chat/completions
        │  GET  /v1/models
        │  GET  /v1/status
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Hono app (Bun)                             │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Middleware                                              │  │
│  │  1. Body size limit (reject >1MB)                       │  │
│  │  2. Request ID (sequential, logged with every line)     │  │
│  │  3. Auth guard (timingSafeEqual on server.apiKey)       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│  ┌─────────────┐          │          ┌─────────────────────┐   │
│  │ModelRegistry│◀─────────┤          │  RoutingStrategy    │   │
│  │ + fs.watch  │          │          │  selectAccounts()   │   │
│  │ hot-reload  │          ▼          └─────────────────────┘   │
│  └─────────────┘   ChatHandler                │                 │
│                    (inline retry loop)         │                 │
│  ┌─────────────┐          │                   │                 │
│  │Credential   │◀─────────┤  for account of selectAccounts():  │
│  │Store        │          │    resolve() → requestHeaders()     │
│  │+ in-flight  │          │    fetch(url, { signal, headers })  │
│  │  dedup      │          │    on error: onError() + continue   │
│  └─────────────┘          │                                     │
│                           ▼                                     │
│  ┌─────────────┐   UsageSynthesisTransform                     │
│  │ LockStore   │   (SSE parse + usage detect + synthesize)     │
│  │ bun:sqlite  │          │                                     │
│  └─────────────┘          ▼                                     │
│                    Stream to client                              │
│  ┌─────────────┐          │                                     │
│  │ UsageStore  │◀─── record() fire-and-forget                  │
│  │ bun:sqlite  │                                                │
│  └─────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼ upstream HTTP (fetch with AbortController)
┌────────────────────────────────────────────────────────────────┐
│  GitHub Copilot   │  OpenAI Codex     │  API-key providers     │
│  (OAuth bearer)   │  (OAuth PKCE)     │  (OpenAI, OpenRouter)  │
│                   │                   │                        │
│  requestHeaders:  │  requestHeaders:  │  requestHeaders:       │
│  Authorization    │  Authorization    │  Authorization         │
│  Editor-Version   │  (standard only)  │  (standard only)       │
│  Copilot-Int-Id   │                   │                        │
└────────────────────────────────────────────────────────────────┘
```

---

## Folder Structure

```
local-router/
├── bin/
│   └── keyrouter.ts              # Entry: 'start' (server) | 'auth <provider>' (CLI)
├── src/
│   ├── index.ts                  # Hono app setup + middleware + route registration
│   ├── config.ts                 # router.json parse + fs.watch hot-reload
│   ├── types.ts                  # ALL shared interfaces (single source of truth)
│   ├── db/
│   │   └── migrations.ts         # Schema versioning + CREATE TABLE IF NOT EXISTS
│   ├── auth/
│   │   ├── store.ts              # CredentialStore: resolve() with in-flight dedup
│   │   ├── copilot.ts            # CopilotOAuth: device flow + token refresh
│   │   ├── codex.ts              # CodexOAuth: PKCE flow + token refresh (Phase 2)
│   │   └── apikey.ts             # ApiKeyCredential: static, never expires
│   ├── providers/
│   │   ├── index.ts              # Provider registry: id → ProviderDefinition
│   │   ├── copilot.ts            # Copilot: requestHeaders() with capability headers
│   │   ├── openai.ts             # OpenAI: standard auth header only
│   │   └── openrouter.ts         # OpenRouter: standard auth header + extra headers
│   ├── registry/
│   │   └── index.ts              # ModelRegistry: lookup() + hot-swap on config reload
│   ├── translation/
│   │   ├── stream.ts             # UsageSynthesisTransform: SSE parse + synthesis
│   │   └── openai-responses.ts   # Responses API translator (Phase 2 only)
│   ├── routing/
│   │   ├── strategy.ts           # selectAccounts(): sorted [unlocked first, locked last]
│   │   └── lock-store.ts         # SQLite model lock backoff (30s→1m→5m→30m)
│   ├── handlers/
│   │   ├── chat-completions.ts   # POST /v1/chat/completions (streaming + non-streaming)
│   │   ├── models.ts             # GET /v1/models
│   │   └── status.ts             # GET /v1/status
│   ├── usage/
│   │   └── store.ts              # UsageStore.record() — always fire-and-forget
│   └── cli/
│       └── auth.ts               # runAuthFlow(provider): device flow + token storage
├── tests/
│   ├── unit/
│   │   ├── registry.test.ts
│   │   ├── routing.test.ts
│   │   ├── credential-store.test.ts
│   │   └── stream.test.ts
│   └── integration/
│       ├── chat-completions.test.ts
│       └── auth-middleware.test.ts
├── router.example.json           # Config template — copy to router.json to start
├── router.json                   # Actual config (gitignore data/ but NOT this)
├── data/                         # SQLite db — gitignored
│   └── router.db
├── .gitignore
├── package.json                  # engines: { bun: ">=1.0.0" }
└── tsconfig.json
```

---

## Shared Types (`src/types.ts`)

All interfaces live in one file. Never split into per-module `types.ts` files.

```typescript
// ─── Credential & Auth ───────────────────────────────────────────────────────

export interface Credential {
  type: 'apiKey' | 'oauthBearer'
  value: string
  expiresAt?: number      // unix ms; undefined = never expires
  refreshToken?: string
}

export interface OAuthProvider {
  fetchToken(): Promise<Credential>              // starts device flow, polls, returns
  refreshToken(cred: Credential): Promise<Credential>
  isExpiringSoon(cred: Credential): boolean     // true if expiresAt < now + 5min
}

export interface CredentialStore {
  // Fetches credential, refreshing if expiring. De-duplicates concurrent refreshes.
  resolve(providerId: string, accountId: string): Promise<Credential>
  store(providerId: string, accountId: string, cred: Credential): Promise<void>
}

// ─── Provider ────────────────────────────────────────────────────────────────

export interface ProviderDefinition {
  id: string
  baseURL: string
  // Returns ALL upstream request headers: Authorization + any provider-specific ones.
  // Copilot requires Editor-Version, Editor-Plugin-Version, Copilot-Integration-Id.
  requestHeaders(cred: Credential): Record<string, string>
  endpoint: {
    chatCompletions: string   // e.g. '/v1/chat/completions'
    responses?: string        // Phase 2 only
  }
}

// ─── Model Registry ──────────────────────────────────────────────────────────

export interface ModelEntry {
  modelId: string           // what client sends, e.g. "gpt-4o"
  providerId: string
  accounts: string[]        // try in order (matched to provider accounts)
  endpoint: 'chat' | 'responses'
  capabilities: {
    streaming: boolean
    toolCalls: boolean
    vision: boolean
    reasoning: boolean      // if true, preserve reasoning_opaque passthrough
    maxContextTokens: number
  }
}

// ─── Routing ─────────────────────────────────────────────────────────────────

export interface AccountEntry {
  id: string
  providerId: string
}

export interface RoutingStrategy {
  // Returns accounts sorted: unlocked (round-robin) first, locked (by expiry asc) last.
  // Returns [] if all accounts are locked.
  selectAccounts(modelId: string, accounts: AccountEntry[]): AccountEntry[]
  onSuccess(accountId: string, modelId: string): void
  onError(accountId: string, modelId: string, statusCode: number): void
}

// ─── Translation ─────────────────────────────────────────────────────────────

export interface StreamState {
  id: string
  model: string
  created: number
  usageEmitted: boolean
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export interface UsageRecord {
  ts: number
  modelId: string
  providerId: string
  accountId: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  statusCode: number
  error?: string
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RouterConfig {
  server: {
    port: number            // default 3000
    apiKey?: string         // if set, all requests must include Authorization: Bearer <key>
  }
  models: ModelConfig[]
  providers: ProviderConfig[]
}

export interface ModelConfig {
  id: string                // client-facing model ID
  providerId: string
  accounts: string[]
  endpoint: 'chat' | 'responses'
  capabilities: {
    toolCalls: boolean
    streaming: boolean
    reasoning: boolean
    vision: boolean
    maxContextTokens: number
  }
}

export interface ProviderConfig {
  id: string
  type: 'copilot-oauth' | 'codex-oauth' | 'apikey' | 'openai-compatible'
  baseURL: string
  accounts: { id: string; apiKey?: string }[]
}

// ─── Request/Response ────────────────────────────────────────────────────────

// CRITICAL: Never destructure this type. Always spread when modifying:
//   ✓ { ...req, model: resolvedModel }
//   ✗ const { model, messages, ...rest } = req   ← strips unknown fields
//
// Copilot messages carry reasoning_opaque and reasoning_text. If stripped,
// multi-turn reasoning silently resets each turn.
export interface CanonicalChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
  temperature?: number
  max_tokens?: number
  stream_options?: { include_usage?: boolean }
  [key: string]: unknown    // MUST forward all unknown fields verbatim
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | unknown[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_text?: string         // Copilot: MUST passthrough
  reasoning_opaque?: string       // Copilot: MUST passthrough — never strip
  [key: string]: unknown
}

export interface ToolCall {
  id: string            // NEVER rewrite — tool_call_id in next turn must match exactly
  type: 'function'
  function: { name: string; arguments: string }
}
```

---

## Request Hot Path (chat completions)

```
POST /v1/chat/completions
        │
        ├─ [Body size check] ──────────────────────────────► 413
        ├─ [Auth guard] ───────────────────────────────────► 401
        │
        ├─ ModelRegistry.lookup(req.model)
        │     null ───────────────────────────────────────► 404 OpenAI error format
        │
        ├─ routing.selectAccounts(modelId, model.accounts)
        │     [] ─────────────────────────────────────────► 503 + Retry-After
        │
        ├─ for (const account of accounts):
        │     │
        │     ├─ credStore.resolve(providerId, accountId)
        │     │     CredentialNotFound ─────────────────►  503 "run keyrouter auth <provider>"
        │     │     OAuthRevokedError ──────────────────►  503 "token revoked, re-run auth"
        │     │
        │     ├─ provider.requestHeaders(cred)
        │     │
        │     ├─ fetch(url, { signal: c.req.raw.signal, headers, body })
        │     │     timeout / 5xx ──► routing.onError() + continue (next account)
        │     │     429 ────────────► routing.onError() + continue
        │     │     401 ────────────► attempt refresh → OAuthRevokedError if refresh 401
        │     │     HTML body ───────► JSON.parse catch → 503 "provider unavailable"
        │     │     success ──────────► break loop
        │     │
        │     └─ (all accounts tried, none succeeded) ──► 503 "no accounts available"
        │
        ├─ if req.stream === false:
        │     buffer full response body → return JSON
        │
        └─ else:
              UsageSynthesisTransform.pipe(upstreamResponse)
                    │
                    ├─ Parse SSE line by line
                    │     malformed ─► try/catch → log.warn + skip, continue
                    │
                    ├─ Detect usage chunk → state.usageEmitted = true
                    │
                    ├─ On [DONE]: if !state.usageEmitted → yield synthesized usage chunk
                    │
                    └─ yield "data: [DONE]\n\n"
                              │
                              ├─ usageStore.record(...).catch(log.warn)  // fire-and-forget
                              └─ routing.onSuccess(accountId, modelId)
```

---

## Credential Store State Machine

```
resolve(providerId, accountId)
        │
        ├─ db.getCred() → null
        │     └─► throw CredentialNotFound
        │
        ├─ db.getCred() → cred, !isExpiringSoon(cred)
        │     └─► return cred  (fast path)
        │
        ├─ db.getCred() → cred, isExpiringSoon(cred), refreshing.has(key)
        │     └─► return refreshing.get(key)!  (share in-flight promise)
        │
        └─ db.getCred() → cred, isExpiringSoon(cred), !refreshing.has(key)
              │
              ├─ p = provider.refreshToken(cred)
              │       .finally(() => refreshing.delete(key))
              ├─ refreshing.set(key, p)
              └─ return p
                    │
                    ├─ success → db.storeCred() → return new cred
                    └─ 401 from refresh endpoint → throw OAuthRevokedError
                                                    (clear stored token)
```

---

## Lock Backoff Sequence

```
attempt_count → locked_until duration
0             → not locked (first failure not tracked)
1             → +30s
2             → +60s
3             → +300s (5min)
4+            → +1800s (30min)

Triggered by: 429, 5xx from provider
NOT triggered by: 401 (handled as token revocation, not rate limit)
Cleared by: routing.onSuccess() after any successful response
```

---

## SQLite Schema

```sql
-- Schema versioning
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- OAuth + API key credentials
CREATE TABLE IF NOT EXISTS credentials (
  provider_id   TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  token         TEXT NOT NULL,
  expires_at    INTEGER,          -- unix ms; NULL = never expires
  refresh_token TEXT,
  PRIMARY KEY (provider_id, account_id)
);

-- Per-account, per-model rate limit locks
CREATE TABLE IF NOT EXISTS model_locks (
  account_id     TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  locked_until   INTEGER NOT NULL, -- unix ms
  attempt_count  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, model_id)
);

-- Request usage log
CREATE TABLE IF NOT EXISTS usage (
  ts                INTEGER NOT NULL,
  model_id          TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL,
  status_code       INTEGER NOT NULL,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
```

---

## API Surface

### `GET /v1/models`
Returns configured model list in OpenAI format. Reads from `ModelRegistry`.

### `POST /v1/chat/completions`
Main routing endpoint. Supports both `stream: true` (SSE) and `stream: false` (JSON).

**Request passthrough rules:**
- Never rewrite `tool_calls[].id` — client resends these on the next turn
- Never strip unknown message fields — `reasoning_opaque` must survive
- Always forward `stream_options` verbatim to upstream

### `GET /v1/status`
Returns provider health for debugging. Not part of the OpenAI API spec.

```json
{
  "uptime": 3600,
  "providers": [
    {
      "id": "copilot",
      "accounts": [
        {
          "id": "default",
          "tokenExpiry": "2026-03-17T11:00:00.000Z",
          "locked": false,
          "lockedUntil": null
        }
      ]
    }
  ],
  "models": ["gpt-4o", "claude-3-7-sonnet", "o3"]
}
```

---

## `router.json` Schema

```jsonc
{
  "server": {
    "port": 3000,
    "apiKey": "local-secret"   // optional — omit to allow unauthenticated access
  },
  "providers": [
    {
      "id": "copilot",
      "type": "copilot-oauth",
      "baseURL": "https://api.githubcopilot.com",
      "accounts": [
        { "id": "default" }    // token stored in SQLite by keyrouter auth copilot
      ]
    },
    {
      "id": "openai",
      "type": "apikey",
      "baseURL": "https://api.openai.com",
      "accounts": [
        { "id": "main", "apiKey": "sk-..." }
      ]
    }
  ],
  "models": [
    {
      "id": "gpt-4o",
      "providerId": "copilot",
      "accounts": ["default"],
      "endpoint": "chat",
      "capabilities": {
        "toolCalls": true,
        "streaming": true,
        "reasoning": false,
        "vision": true,
        "maxContextTokens": 128000
      }
    },
    {
      "id": "o3",
      "providerId": "copilot",
      "accounts": ["default"],
      "endpoint": "chat",
      "capabilities": {
        "toolCalls": true,
        "streaming": true,
        "reasoning": true,
        "vision": false,
        "maxContextTokens": 200000
      }
    }
  ]
}
```

---

## OpenCode Client Config

Configure OpenCode with `@ai-sdk/openai-compatible` — this guarantees only `/v1/chat/completions` is called (never `/v1/responses`):

```jsonc
// opencode.json (in project root or ~/.config/opencode/)
{
  "provider": {
    "keyrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:3000/v1",
        "apiKey": "local-secret"
      },
      "models": {
        "gpt-4o": { "name": "gpt-4o" },
        "o3": { "name": "o3" }
      }
    }
  }
}
```

> **Warning:** Do NOT use `@ai-sdk/openai` — it routes `gpt-5+` models to `/v1/responses`, which is Phase 2 scope.

---

## Security

| Concern | Mitigation |
|---------|-----------|
| `data/router.db` file permissions | Set `0o600` immediately after opening — tokens stored in plain SQLite |
| API key timing attack | Use `crypto.timingSafeEqual()` for incoming key comparison |
| `data/` accidentally committed | Add to `.gitignore` |
| Copilot ToS: multiple account rotation | Start with single account; document risk in README |

---

## Startup Sequence

1. Parse `router.json` — exit 1 with instructions if missing
2. Create `data/` directory if absent
3. Open `bun:sqlite` database (auto-creates `data/router.db`)
4. `fs.chmodSync('data/router.db', 0o600)`
5. `db.exec('PRAGMA journal_mode=WAL')`
6. Run schema migrations
7. Load `ModelRegistry` from config
8. Register `fs.watch('router.json', ...)` for hot-reload
9. Start Hono server on configured port (catch EADDRINUSE, print helpful error)
10. Print startup banner:
    ```
    keyrouter v0.1.0  →  http://localhost:3000/v1

    Models:
      gpt-4o     copilot/default  ✓
      o3         copilot/default  ✓

    Add to opencode.json:
      "baseURL": "http://localhost:3000/v1"
    ```

---

## Phase 2+ Extensions

The architecture supports these without structural changes:

| Extension | Where | Notes |
|-----------|-------|-------|
| `POST /v1/responses` | `handlers/responses.ts` | Add `OpenAIResponsesTranslator` in `translation/` |
| Codex OAuth | `auth/codex.ts` | Same `OAuthProvider` interface; PKCE flow |
| Claude Code OAuth | `auth/claude-code.ts` | Same interface; reference: CLIProxyAPI antigravity |
| Gemini CLI OAuth | `auth/gemini.ts` | Same interface |
| Web dashboard | `handlers/status-ui.ts` | Serve HTML that polls `/v1/status` |

See `TODOS.md` for deferred items.

---

## Codex OAuth Constants
- ClientID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Auth URL: `https://auth.openai.com/oauth/authorize`
- Token URL: `https://auth.openai.com/oauth/token`
- RedirectURI: `http://localhost:1455/auth/callback`
- PKCE: S256
- Scopes: `openid email profile offline_access`
- Extra params: `prompt=login`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`
