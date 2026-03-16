---
name: Implementation plan and risks
description: Step-by-step build plan for the lightweight router, MVP scope, and risks with mitigations
type: project
---

## MVP Scope

### Must-Have
- `POST /v1/chat/completions` with streaming SSE
- `GET /v1/models` returning configured model list
- GitHub Copilot OAuth provider (token fetch + refresh)
- At least one API-key provider (OpenAI or OpenRouter as fallback)
- Per-model routing table (model string → provider + credentials)
- Request passthrough of unknown fields — no stripping
- Correct SSE termination: synthesize usage chunk + `data: [DONE]`

### Should-Have (phase 2)
- `POST /v1/responses` for gpt-5+/Codex compatibility
- OpenAI Codex OAuth provider
- Multiple accounts per provider (round-robin or fallback)
- Exponential backoff on 429/5xx with model-level locking
- SQLite credential storage with token refresh
- Simple `router.json` config file

### Avoid For Now
- Web dashboard
- Semantic/Redis caching
- Format translation beyond OpenAI ↔ OpenAI-responses
- Guardrails / hooks pipeline
- gRPC Connect (Cursor) or AWS binary protocol (Kiro)

## Step-by-Step Build Plan

### Phase 1: Skeleton + API key provider (2–3 hours)
1. `npm init` with Hono + TypeScript + `better-sqlite3`
2. `GET /v1/models` → reads from `router.json`
3. `POST /v1/chat/completions` → passthrough to OpenAI with API key
4. SSE streaming passthrough (pipe upstream response directly)
5. Test with OpenCode `opencode.json` pointing at `http://localhost:3000/v1`

### Phase 2: Model registry + routing (1–2 hours)
6. `ModelRegistry.lookup(modelId)` → `ModelConfig`
7. `RoutingStrategy`: pick first non-locked account
8. Wire model lookup into chat handler

### Phase 3: SQLite credential store + Copilot OAuth (3–4 hours)
9. SQLite schema: `credentials(provider_id, account_id, token, expires_at, refresh_token)`
10. `CredentialStore.get()` with auto-refresh (5-min buffer check)
11. `CopilotOAuth.fetchToken()` — device auth flow, poll, store token
   - Reference: `/Users/canh/Projects/OSS/routers/9router/src/sse/services/auth.js`
12. Wire credential resolution into handler

### Phase 4: Fallback + lock tracking (1–2 hours)
13. SQLite schema: `model_locks(account_id, model_id, locked_until)`
14. Backoff lock: 30s → 1m → 5m → 30m on 429/5xx
15. Retry loop that tries next account on lock

### Phase 5: Codex OAuth + `/v1/responses` (2–3 hours, optional)
16. `CodexOAuth.fetchToken()` — same pattern, endpoint `https://auth.openai.com/oauth/token`
17. `POST /v1/responses` handler
18. `OpenAIResponsesTranslator` — convert between `input[]` and `messages[]`

### Phase 6: Hardening (1 hour)
19. Audit all transforms — ensure unknown fields forwarded
20. Verify `reasoning_opaque` and `reasoning_text` never stripped
21. Validate usage chunk synthesis before `[DONE]`
22. Test multi-turn with tool calls end-to-end

## Risks and Mitigations

### R1: Copilot/Codex OAuth flows change without notice [HIGH]
Both expose unofficial/subscription-gated APIs. Client IDs may change, device flows may be restricted.
**Mitigation:** Copy 9router's working OAuth code as starting point. Use `node-machine-id` for consistent device identity. Add fallback to API-key provider on OAuth failure.

### R2: `reasoning_opaque` stripped silently [MEDIUM]
Any typed schema (Zod strict) will strip unknown fields. Multi-turn Copilot resets reasoning state each turn with no error.
**Mitigation:** Use `.passthrough()` on all Zod message schemas. Use `[key: string]: unknown` spread in TypeScript interfaces. Never destructure-then-reconstruct messages.

### R3: Tool call ID rewrite breaks multi-turn tool calls [MEDIUM]
If router rewrites tool call IDs, the ID in history OpenCode resends on turn N+1 will be the rewritten ID. This is internally consistent only if IDs are rewritten deterministically and stably.
**Mitigation:** For MVP passthrough translator, never rewrite tool call IDs. Pass verbatim.

### R4: Usage chunk missing in stream [LOW-MEDIUM]
`@ai-sdk/openai-compatible` (Vercel AI SDK v5) may throw on missing usage before `[DONE]`. Copilot and some providers don't emit usage.
**Mitigation:**
```typescript
if (!state.usageEmitted) {
  yield `data: ${JSON.stringify({
    id: state.id, object: "chat.completion.chunk",
    choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  })}\n\n`
}
yield `data: [DONE]\n\n`
```

### R5: `/v1/responses` partial implementation [MEDIUM]
Responses API has web_search_call, code_interpreter_call event types. Partial support causes silent feature loss.
**Mitigation:** For MVP, implement only `function_call`/`function_call_output`. Return `501 Not Implemented` for other tool event types.

### R6: Copilot per-device rate limits / ToS [MEDIUM]
Copilot API may enforce per-user limits. Multiple account rotation may violate ToS.
**Mitigation:** Start with single account. Use 9router's model-locking logic to respect rate limits. Document ToS risk.

## Key Reference Files

### CLIProxyAPI (Go original — preferred reference for OAuth and conductor logic)
- Codex PKCE OAuth: `/Users/canh/Projects/OSS/routers/CLIProxyAPI/sdk/auth/codex.go`
- Codex device flow: `/Users/canh/Projects/OSS/routers/CLIProxyAPI/sdk/auth/codex_device.go`
- Antigravity OAuth: `/Users/canh/Projects/OSS/routers/CLIProxyAPI/internal/auth/antigravity/auth.go`
- Auth conductor (rotation, cooldown, refresh): `/Users/canh/Projects/OSS/routers/CLIProxyAPI/sdk/cliproxy/auth/conductor.go`
- Gemini schema cleaning: `/Users/canh/Projects/OSS/routers/CLIProxyAPI/internal/util/gemini_schema.go`
- Config example: `/Users/canh/Projects/OSS/routers/CLIProxyAPI/config.example.yaml`
- Main entry: `/Users/canh/Projects/OSS/routers/CLIProxyAPI/cmd/server/main.go`

### 9router (JS port — reference for GitHub Copilot and JS-specific patterns)
- GitHub Copilot + all OAuth flows: `/Users/canh/Projects/OSS/routers/9router/src/sse/services/auth.js`
- Streaming handler: `/Users/canh/Projects/OSS/routers/9router/open-sse/handlers/chatCore/streamingHandler.js`
- Tool call helper: `/Users/canh/Projects/OSS/routers/9router/open-sse/translator/helpers/toolCallHelper.js`
- Provider configs: `/Users/canh/Projects/OSS/routers/9router/open-sse/config/providers.js`
- Model routing: `/Users/canh/Projects/OSS/routers/9router/src/sse/services/model.js`

### Codex OAuth Constants (confirmed from CLIProxyAPI source)
- ClientID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Auth URL: `https://auth.openai.com/oauth/authorize`
- Token URL: `https://auth.openai.com/oauth/token`
- RedirectURI: `http://localhost:1455/auth/callback`
- PKCE method: S256
- Scopes: `openid email profile offline_access`
- Extra params: `prompt=login`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`
