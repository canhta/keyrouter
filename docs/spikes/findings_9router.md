---
name: 9router source findings
description: Confirmed architecture details from local 9router codebase — auth flows, proxy logic, format translation, session handling
type: project
---

Source: `/Users/canh/Projects/OSS/routers/9router` — confirmed from code.

> **9router is a JavaScript port of CLIProxyAPI (Go).** For OAuth flow details, conductor logic, and translator patterns, see `findings_cliproxyapi.md` — that is the ground truth implementation. 9router added: SQLite storage, Next.js dashboard, GitHub Copilot support, cursor (gRPC Connect), kiro (AWS binary), and ollama format translators.

## Stack
- Next.js 16 + Express 5, port 20128
- SQLite via `better-sqlite3` for credentials, model locks, usage logs
- `undici` for upstream HTTP calls
- `node-machine-id` for stable device identity

## Exposed Endpoints (confirmed)
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`
- `POST /v1/embeddings`

## OAuth Providers (confirmed from `/src/sse/services/auth.js`)
| Provider | Token endpoint |
|---|---|
| GitHub Copilot (`gh`) | `https://api.githubcopilot.com` |
| OpenAI Codex (`cx`) | `https://auth.openai.com/oauth/token` |
| Claude Code (`cc`) | `https://api.anthropic.com/v1/oauth/token` |
| Gemini CLI (`gc`) | Google client ID |
| Kiro | `https://prod.us-east-1.auth.desktop.kiro.dev` |
| Qwen (`qw`) | `https://chat.qwen.ai/api/v1/oauth2/device/code` |
| iFlow (`if`) | `https://iflow.cn/oauth` |
| Antigravity (`ag`) | Google (CloudCode) |

Token refresh uses **5-minute expiry buffer**. Per-connection session IDs (24h TTL, in-memory) exist only for prompt-cache continuity — they carry no conversation state.

## Format Translators (confirmed from `/open-sse/translator/`)
- `openai` — standard chat/completions
- `openai-responses` — OpenAI Responses API (Codex)
- `claude` — Anthropic Messages format
- `gemini` — Google Gemini format
- `antigravity` — Google CloudCode (wrapped Gemini)
- `cursor` — gRPC Connect protocol
- `kiro` — AWS binary protocol
- `ollama` — Ollama format

## Stateless Behavior (confirmed)
- Zero conversation history stored server-side
- Client MUST send full `messages[]` array on every request
- This is intentional and correct — same as OpenAI API spec
- "Single-turn" feeling is NOT caused by statelessness

## Model Locking (confirmed from `/src/sse/services/auth.js`)
- Per-model rate-limit tracking: `modelLock_{modelId}`
- Exponential backoff: 30s → 1m → 5m → 30m
- Stored in SQLite, survives restarts

## Tool Call Handling (confirmed from `/open-sse/translator/helpers/toolCallHelper.js`)
- Generates IDs: `call_{timestamp}_{randomSuffix}` — WARNING: these IDs are generated on inbound, meaning multi-turn tool call IDs need careful passthrough
- `fixMissingToolResponses()` auto-inserts empty tool results if missing
- Supports OpenAI and Claude tool call formats bidirectionally

## Streaming (confirmed from `/open-sse/handlers/chatCore/streamingHandler.js`)
- Per-provider SSE transform stream
- Real-time format translation chunk-by-chunk
- Synthesizes non-streaming from streamed responses when needed

## Key Differences vs CLIProxyAPI (the original)
| Feature | CLIProxyAPI (Go) | 9router (JS port) |
|---|---|---|
| Framework | Gin | Next.js + Express |
| Storage | Filesystem + Postgres/Git/S3 | SQLite (better-sqlite3) |
| Config | YAML | SQLite + env |
| Token refresh buffer | Provider-specific (15min Claude, 1hr Gemini) | 5-minute flat |
| Cooldown backoff | base 1s → max 30min | 30s → 1m → 5m → 30m |
| Extra providers | — | GitHub Copilot, Kiro, cursor (gRPC), ollama |
| Hot-reload | Yes (fsnotify) | No |
| SDK | Embeddable Go SDK | No |
| TUI | Yes | Web dashboard |
| Amp CLI | Yes | No |

## Key Insight
For OAuth implementation, **CLIProxyAPI is the ground truth** — use `sdk/auth/codex.go` for Codex PKCE flow and `internal/auth/antigravity/auth.go` for Antigravity. For GitHub Copilot (not in CLIProxyAPI), 9router is the only reference: `src/sse/services/auth.js`.
