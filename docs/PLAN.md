# keyrouter — Implementation Plan

> Authoritative plan. Supersedes `docs/spikes/implementation_plan.md`.
> Reflects all decisions from CEO review and Engineering review (2026-03-17).
>
> See `docs/ARCHITECTURE.md` for interfaces, data flow diagrams, and type definitions.
> See `TODOS.md` for deferred items (doctor command, Claude Code OAuth, dashboard).

---

## MVP Scope

### Must-Have (Phases 1–4)
- `POST /v1/chat/completions` — streaming SSE + non-streaming JSON
- `GET /v1/models` — returns configured model list
- `GET /v1/status` — provider health, token expiry, active locks
- GitHub Copilot OAuth provider (device flow, token refresh, 5-min buffer)
- At least one API-key provider (OpenAI or OpenRouter as fallback)
- Per-model routing table (`model ID → provider + accounts`)
- Request passthrough of all unknown fields — never strip anything
- Correct SSE termination: synthesize usage chunk + `data: [DONE]`
- `keyrouter auth <provider>` CLI for device flow
- Hot-reload `router.json` without restart
- Startup banner
- `bun test` suite (unit + integration) passing before Phase 1 is done

### Phase 2 (after MVP is solid)
- `POST /v1/responses` for gpt-5+/Codex compatibility
- OpenAI Codex OAuth provider (PKCE flow)
- Multiple accounts per provider (round-robin within unlocked accounts)
- `router.json` hot-reload already in MVP

### Deferred (see TODOS.md)
- `keyrouter doctor` command
- Claude Code OAuth
- Web status dashboard
- Semantic/Redis caching
- Format translation beyond OpenAI ↔ OpenAI-responses
- gRPC Connect (Cursor), AWS binary (Kiro)

---

## Phase 1: Skeleton + API key provider (2–3 hours)

**Goal:** Server starts, routes a request to OpenAI, SSE streams back correctly, tests pass.

### Steps

**1. Project init**
```bash
mkdir local-router && cd local-router
bun init -y
bun add hono
```

`package.json`:
```json
{
  "name": "keyrouter",
  "version": "0.1.0",
  "scripts": {
    "start": "bun run bin/keyrouter.ts",
    "test": "bun test"
  },
  "engines": { "bun": ">=1.0.0" }
}
```

**2. DB setup (`src/db/migrations.ts`)**
- Open `bun:sqlite` database at `data/router.db`
- `fs.chmodSync('data/router.db', 0o600)`
- `PRAGMA journal_mode=WAL`
- Create tables: `schema_version`, `credentials`, `model_locks`, `usage`
- See schema in `ARCHITECTURE.md`

**3. `GET /v1/models`** → reads from `ModelRegistry` → returns OpenAI format

**4. `GET /v1/status`** → reads providers + credentials + locks → returns health JSON

**5. `POST /v1/chat/completions` → OpenAI API key passthrough**
- Parse + validate body (size limit via Hono middleware)
- `ModelRegistry.lookup(model)` → 404 if not found (OpenAI error format)
- `RoutingStrategy.selectAccounts()` → iterate accounts
- `CredentialStore.resolve()` → get API key credential
- `provider.requestHeaders(cred)` → build headers
- `fetch(url, { signal: c.req.raw.signal, headers, body })` ← AbortController required
- On success: pipe through `UsageSynthesisTransform`
- Handle `stream: false` (buffer + return JSON)

**6. `UsageSynthesisTransform` (`src/translation/stream.ts`)**
```
Input:  raw SSE bytes from upstream
Output: normalized SSE bytes to client

  ┌─────────────────────────────────────────────────────────┐
  │  UsageSynthesisTransform                                │
  │                                                         │
  │  line by line:                                          │
  │  ┌──────────────────────────────────────────────────┐  │
  │  │ "data: {...}" → JSON.parse (try/catch: skip bad) │  │
  │  │ if chunk has usage → state.usageEmitted = true   │  │
  │  │ yield chunk as-is                                │  │
  │  └──────────────────────────────────────────────────┘  │
  │                                                         │
  │  on "data: [DONE]":                                     │
  │  ┌──────────────────────────────────────────────────┐  │
  │  │ if !state.usageEmitted → yield synthetic usage   │  │
  │  │ yield "data: [DONE]\n\n"                         │  │
  │  │ usageStore.record(...).catch(warn)  // async     │  │
  │  │ routing.onSuccess(accountId, modelId)            │  │
  │  └──────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────┘
```

**7. Hot-reload `router.json`**
```typescript
// config.ts
fs.watch('router.json', () => {
  try {
    const config = JSON.parse(fs.readFileSync('router.json', 'utf8'))
    modelRegistry.swap(config)  // atomic ref swap
  } catch {
    // partial write — ignore, next event will catch complete file
  }
})
```

**8. Startup banner + error handling**
- Missing `router.json` → print usage instructions + exit 1
- Port in use → print "Port X is in use. Set server.port in router.json." + exit 1
- Print banner: loaded models, provider status, OpenCode config snippet

**9. Write Phase 1 tests (required before Phase 1 is complete)**

Unit tests (`tests/unit/`):
- `registry.test.ts`: lookup hit returns `ModelEntry`, lookup miss returns null
- `routing.test.ts`: `selectAccounts` returns unlocked first; lock backoff 30s→60s→300s→1800s
- `credential-store.test.ts`: fresh → return as-is; expiring → triggers refresh; concurrent → one refresh; revoked 401 → `OAuthRevokedError`
- `stream.test.ts`: missing usage → synthesized before [DONE]; malformed chunk → skipped, stream continues

Integration tests (`tests/integration/`):
- `chat-completions.test.ts`: mock provider → full SSE path; 429 → lock + retry next account; HTML body → 503
- `auth-middleware.test.ts`: valid key → 200; invalid key → 401; no key configured → passes through

**10. Test with OpenCode**
Configure `opencode.json`:
```jsonc
{
  "provider": {
    "keyrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:3000/v1", "apiKey": "local-secret" },
      "models": { "gpt-4o": { "name": "gpt-4o" } }
    }
  }
}
```

---

## Phase 2: Model registry + routing (1–2 hours)

**Goal:** Multiple providers and accounts configured; retry/fallback working.

**11. `RoutingStrategy` full implementation (`src/routing/strategy.ts`)**

```
selectAccounts(modelId, accounts):
  ┌─────────────────────────────────────────────────────────┐
  │  Read all lock expiries from LockStore                  │
  │                                                         │
  │  unlocked = accounts where lockedUntil < now            │
  │  locked   = accounts where lockedUntil >= now           │
  │                                                         │
  │  Sort unlocked: round-robin by (lastUsed offset)        │
  │  Sort locked:   by lockedUntil ASC                      │
  │                                                         │
  │  return [...unlocked, ...locked]                        │
  └─────────────────────────────────────────────────────────┘
```

**12. Wire `ModelRegistry` to `router.json` model list**
- `ModelRegistry.lookup(modelId)` → `ModelEntry | null`
- `ModelRegistry.list()` → `ModelEntry[]` (for GET /v1/models)
- `ModelRegistry.swap(config)` → atomic hot-reload

**13. Test multi-account failover end-to-end**

---

## Phase 3: SQLite credential store + Copilot OAuth (3–4 hours)

**Goal:** Copilot OAuth device flow working; tokens stored and auto-refreshed.

**14. `CredentialStore` with in-flight dedup (`src/auth/store.ts`)**

```typescript
// See state machine diagram in ARCHITECTURE.md
class CredentialStore {
  private refreshing = new Map<string, Promise<Credential>>()
  // ...
}
```

**15. `CopilotOAuth.fetchToken()` — device auth flow (`src/auth/copilot.ts`)**

Reference: `../9router/src/sse/services/auth.js`

Flow:
1. POST device code endpoint → get `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`
2. Print `user_code` and `verification_uri` to console
3. Poll token endpoint every `interval` seconds until:
   - Success → store token in `CredentialStore` → return `Credential`
   - `authorization_pending` → continue polling
   - `slow_down` → increase interval by 5s
   - `expired_token` → throw `DeviceCodeExpiredError`
   - `access_denied` → throw `OAuthClientError`

**16. `CopilotOAuth.refreshToken()` — token refresh**

- POST token endpoint with `refresh_token`
- 200 → update stored credential
- 401 → throw `OAuthRevokedError` (credential cleared by store)

**17. `keyrouter auth <provider>` CLI (`bin/keyrouter.ts` + `src/cli/auth.ts`)**

```typescript
// bin/keyrouter.ts
const [cmd, ...args] = Bun.argv.slice(2)
if (cmd === 'auth') {
  const { runAuthFlow } = await import('../src/cli/auth')
  await runAuthFlow(args[0])   // 'copilot' | 'codex'
} else {
  const { startServer } = await import('../src/index')
  await startServer()
}
```

`runAuthFlow` orchestrates: load config → find provider → call `fetchToken()` → store credential → print success.

**18. Copilot provider headers (`src/providers/copilot.ts`)**

```typescript
requestHeaders(cred: Credential): Record<string, string> {
  return {
    'Authorization': `Bearer ${cred.value}`,
    'Editor-Version': 'Neovim/0.9.5',
    'Editor-Plugin-Version': 'copilot.vim/1.16.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'Content-Type': 'application/json',
  }
}
```

**19. Wire credential resolution into handler**

---

## Phase 4: Fallback + lock tracking (1–2 hours)

**Goal:** Rate limits and errors cause graceful fallback, not user-visible failures.

**20. `LockStore` backoff (`src/routing/lock-store.ts`)**

```typescript
// Backoff: attempt 1=30s, 2=60s, 3=300s, 4+=1800s
function lockDuration(attemptCount: number): number {
  const steps = [30_000, 60_000, 300_000, 1_800_000]
  return steps[Math.min(attemptCount - 1, steps.length - 1)]
}
```

**21. Error classification in handler**

```
provider 429 → routing.onError() → lock account → try next
provider 5xx → routing.onError() → lock account → try next
provider 401 → attempt token refresh
  → refresh succeeds → retry same account (once)
  → refresh 401 → OAuthRevokedError → clear token → try next
provider HTML → JSON.parse fail → 503 "provider unavailable"
provider timeout → routing.onError() → lock account → try next
```

**22. Phase 4 hardening tests**
- fetch timeout → retry (integration)
- Client disconnect → upstream `fetch()` aborted (integration)
- Revoked token cleared from DB after 401 on refresh (unit)

---

## Phase 5: Codex OAuth + `/v1/responses` (2–3 hours, optional)

**Goal:** Codex OAuth working; `/v1/responses` supported for gpt-5+ models.

**23. `CodexOAuth.fetchToken()` — PKCE device flow (`src/auth/codex.ts`)**

Reference: `../CLIProxyAPI/sdk/auth/codex.go` + `codex_device.go`

Constants (confirmed from CLIProxyAPI source):
- ClientID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Auth URL: `https://auth.openai.com/oauth/authorize`
- Token URL: `https://auth.openai.com/oauth/token`
- RedirectURI: `http://localhost:1455/auth/callback`
- PKCE: S256
- Scopes: `openid email profile offline_access`
- Extra params: `prompt=login`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`

**24. `POST /v1/responses` handler (`src/handlers/responses.ts`)**

**25. `OpenAIResponsesTranslator` (`src/translation/openai-responses.ts`)**
- Convert `input[]` → `messages[]` for upstream
- Convert response chunks back to Responses API format
- Return `501 Not Implemented` for unsupported event types (`web_search_call`, `code_interpreter_call`)

---

## Phase 6: Hardening (1 hour)

**Goal:** Audit all transforms; verify edge cases; confirm multi-turn with tool calls works.

**26. Passthrough audit**
- Verify all unknown fields forwarded in every code path
- Verify `reasoning_opaque` and `reasoning_text` never stripped
- Grep for any `const { ... } = body` patterns → replace with spreads

**27. SSE termination audit**
- Verify usage chunk always present before `[DONE]` in all test scenarios
- Test with `stream_options: { include_usage: true }` (OpenCode's default)

**28. Tool call end-to-end test**
- Multi-turn conversation with tool calls via OpenCode
- Verify `tool_calls[].id` values are preserved across turns
- Verify assistant tool call + tool result round-trip works

**29. Non-streaming path test**
- Verify `stream: false` returns proper JSON (not SSE)
- Verify non-streaming path handles 429/5xx correctly

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Copilot/Codex OAuth flows change without notice | HIGH | Copy 9router's working OAuth as starting point. Fallback to API-key provider on OAuth failure. |
| `reasoning_opaque` stripped silently | MEDIUM | `.passthrough()` equivalents: `[key: string]: unknown` on all message schemas. Never destructure-then-reconstruct messages. |
| Tool call ID rewrite breaks multi-turn | MEDIUM | For MVP: never rewrite IDs. Pass `tool_calls[].id` verbatim always. |
| Usage chunk missing in stream | LOW-MEDIUM | Synthesize in `UsageSynthesisTransform` before `[DONE]`. Already in Phase 1. |
| `/v1/responses` partial implementation | MEDIUM | Phase 5 only. Return `501` for unsupported event types. |
| Copilot per-device rate limits / ToS | MEDIUM | Start with single account. Use lock backoff. Document ToS risk. |
| HTML error response from provider | LOW | JSON.parse guard in handler. Already in Phase 4. |
| Concurrent refresh race | LOW | In-flight promise dedup in `CredentialStore`. Already in Phase 3. |

---

## Done Criteria

### Phase 1 done when:
- `bun test` passes: all 6 unit test files + 2 integration test files
- `GET /v1/models` returns configured models
- `GET /v1/status` returns provider health
- `POST /v1/chat/completions` with API-key provider works end-to-end
- OpenCode pointed at `http://localhost:3000/v1` completes a 3-turn conversation

### Phase 3 done when:
- `keyrouter auth copilot` completes device flow and stores token
- `POST /v1/chat/completions` routes through Copilot with auto-refresh working
- `reasoning_opaque` preserved in a multi-turn conversation

### Phase 4 done when:
- 429 from primary account causes fallback to secondary account (or 503 with Retry-After)
- Revoked token (401 on refresh) returns 503 with re-auth instructions
- Client disconnect cancels upstream Copilot request

### Full MVP done when:
- All Phase 1–4 done criteria met
- No unknown fields dropped in any code path (passthrough audit passes)
- Tool call multi-turn conversation works end-to-end with OpenCode
