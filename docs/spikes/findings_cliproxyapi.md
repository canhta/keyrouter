---
name: CLIProxyAPI source findings
description: Confirmed architecture from local CLIProxyAPI Go repo — the ORIGINAL implementation that 9router ports. Most authoritative source for OAuth flows, conductor logic, and translator patterns.
type: project
---

Source: `/Users/canh/Projects/OSS/routers/CLIProxyAPI` — confirmed from code.

## What it is
The **original Go implementation** that 9router (JS) is ported from. When 9router behavior seems unclear, this is the ground truth. Written in Go with Gin framework, port 8317 default.

## Stack
- Go 1.26, Gin v1.10.1 HTTP framework
- `fsnotify` for hot-reload of config + auth files
- `tiktoken-go` for token counting
- `charmbracelet/bubbletea` for TUI
- `gorilla/websocket` for WebSocket
- `pgx/v5` + `minio-go` + `go-git` for optional storage backends

## Exposed Endpoints (confirmed from internal/api/)
```
POST /v1/chat/completions
POST /v1/completions
GET  /v1/models
POST /v1/messages              (Claude format)
POST /v1/messages/count_tokens
POST /v1/responses             (non-streaming)
GET  /v1/responses             (WebSocket upgrade for streaming)
POST /v1/responses/compact
GET  /v1beta/models            (Gemini)
POST /v1beta/models/*action    (Gemini streaming + non-streaming)
POST /v1internal:method        (Gemini CLI internal)
```

Management API at `v0/management/` (requires secret-key): config, auth files, API keys, OAuth flows, routing strategy, quotas, usage stats, logs.

## OAuth Providers (confirmed from sdk/auth/ and internal/auth/)

| Provider | Auth URL | Token URL | Client ID | Callback Port |
|---|---|---|---|---|
| Codex (OpenAI) | `https://auth.openai.com/oauth/authorize` | `https://auth.openai.com/oauth/token` | `app_EMoamEEZ73f0CkXaXp7hrann` | 1455 |
| Antigravity | embedded endpoint | embedded endpoint | embedded (hardcoded) | 1456 |
| Claude | `https://claude.ai` | — | — | — |
| Gemini/Vertex | Google OAuth 2.0 | — | — | — |
| Qwen | Alibaba OAuth | — | — | — |
| iFlow | Zhipu OAuth/cookie | — | — | — |
| Kimi | Moonshot OAuth | — | — | — |

### Codex OAuth Detail (confirmed from sdk/auth/codex.go + internal/auth/codex/)
- **PKCE**: S256 challenge/verifier
- **Scopes**: `openid email profile offline_access`
- **Extra params**: `prompt=login`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`
- **Device flow** available: `sdk/auth/codex_device.go` — polls device code endpoint, no browser needed
- **RedirectURI**: `http://localhost:1455/auth/callback`
- **Storage**: `auths/codex-*.json`

### Token Refresh Intervals (confirmed from sdk/cliproxy/auth/conductor.go)
- Claude: 15-minute preferred refresh interval
- Gemini: 1-hour preferred refresh interval
- Codex: Adaptive from OAuth response
- All: Checks `expiry - now <= preferredInterval` → triggers refresh
- Pending retry: 1 min between attempts; Failure retry: 5 min

## Translator Architecture (confirmed from internal/translator/)
Pluggable registry auto-registered via Go `init()` on blank import:
```go
// main.go
import _ "github.com/router-for-me/CLIProxyAPI/v6/internal/translator"
```

Translation pairs available:
- `gemini/gemini`, `gemini/claude`, `gemini/openai`
- `claude/gemini`, `claude/openai`
- + more pairs

Registration: source_protocol + target_protocol + action → transformer function.

## Schema Cleaning (confirmed from internal/util/gemini_schema.go)
4-phase JSON schema cleaner for provider compatibility:
1. Convert `$ref` → description hints, `const` → enum, enum → strings, constraints → description
2. Flatten `allOf`, `anyOf`, `oneOf`
3. Strip unsupported: `$schema`, `$ref`, `$defs`, `definitions`, `minLength`, `maxLength`, `pattern`, `format`, `default`, `additionalProperties`, `x-*`, `nullable`, `title`, `deprecated`
4. Add placeholders for empty schemas (Claude requirement: `reason` field; Gemini: `_` boolean)

Two variants: `CleanJSONSchemaForGemini()` (no placeholders) vs `CleanJSONSchemaForAntigravity()` (with placeholders).

## Routing / Auth Conductor (confirmed from sdk/cliproxy/auth/conductor.go)

**Two strategies:**
- `round-robin` (default): Distributes requests across all available auths, tracks per-model offset
- `fill-first`: Exhausts one auth before moving to next

**Quota cooldown:** Exponential backoff, base 1s → max 30 minutes. Tracks `QuotaExceeded.NextRecoverAt` per auth. Auto-switch to next Gemini project or preview model optional.

**Model Pool Fallback:** Multiple upstream models → single alias, round-robin within pool. Tries next pool model if primary fails (before any output produced).

**Retry**: 3 attempts default, retry on 403/408/500/502/503/504, max interval 30s.

## Config Format (confirmed from config.example.yaml)
YAML-based (not SQLite). Key settings:
```yaml
port: 8317
auth-dir: "~/.cli-proxy-api"   # OAuth token file storage
routing:
  strategy: "round-robin"      # or "fill-first"
quota-exceeded:
  switch-project: true
  switch-preview-model: true
streaming:
  keepalive-seconds: 15
  bootstrap-retries: 1
payload:                        # Inject params when missing
  default:
    - models: [{ name: "gemini-*", protocol: "gemini" }]
      params:
        "generationConfig.thinkingConfig.thinkingBudget": 32768
```

Supports `openai-compatibility` entries for any OpenAI-compatible upstream.

## Storage Backends
- **Default**: Local filesystem (`auths/` directory)
- **PostgreSQL**: `PGSTORE_DSN` env var — enterprise credential storage
- **Git**: `GITSTORE_GIT_URL` — credentials in git repo
- **Object Storage**: `OBJECTSTORE_ENDPOINT` — S3-compatible

## What CLIProxyAPI Has That 9router Does NOT
- Embeddable Go SDK (`sdk/cliproxy`) for building custom proxies
- Multiple storage backends (Postgres, Git, object storage)
- TUI management interface (`internal/tui`)
- Config + auth hot-reload via fsnotify
- `payload` injection (inject params when missing from request)
- `ampcode` integration for Amp CLI routing/model mapping
- Model registry background updater (fetches latest model defs from network)
- Signature caching (`internal/cache`)
- Commercial mode flag (reduces per-request overhead)
- WebSocket realtime API (`GET /v1/responses` upgrades to WS)

## Key Files for keyrouter Implementation
- Codex OAuth: `sdk/auth/codex.go`, `sdk/auth/codex_device.go`
- Antigravity OAuth: `internal/auth/antigravity/auth.go`, `sdk/auth/antigravity.go`
- Conductor logic: `sdk/cliproxy/auth/conductor.go`
- Config schema: `config.example.yaml`
- Schema cleaning: `internal/util/gemini_schema.go`
- Main entry: `cmd/server/main.go`
