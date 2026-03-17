# keyrouter

**A self-hosted AI router that handles subscription-backed OAuth providers — GitHub Copilot, OpenAI Codex, and standard API-key providers — behind a single OpenAI-compatible endpoint.**

```
                          ┌─────────────────────┐
  OpenCode / Cursor /     │                     │   GitHub Copilot (OAuth)
  Continue / any          │     keyrouter       │   OpenAI Codex (PKCE OAuth)
  OpenAI-compatible  ───► │  localhost:3000/v1  │   OpenAI (API key)
  tool                    │                     │   OpenRouter (API key)
                          └─────────────────────┘
```

[![CI](https://github.com/canhta/keyrouter/actions/workflows/ci.yml/badge.svg)](https://github.com/canhta/keyrouter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

---

## Why keyrouter?

Standard AI gateways (Portkey, OpenRouter, LiteLLM) work great for API-key providers. But **GitHub Copilot** and **OpenAI Codex** use subscription-backed OAuth — they don't issue API keys. keyrouter handles the OAuth device flows so you can use your existing subscriptions from any tool.

| Feature | keyrouter | Standard gateways |
|---------|-----------|-------------------|
| GitHub Copilot (OAuth) | ✅ | ❌ |
| OpenAI Codex (PKCE OAuth) | ✅ | ❌ |
| OpenAI / OpenRouter (API key) | ✅ | ✅ |
| Per-account rate-limit backoff | ✅ | varies |
| Account rotation / fallback | ✅ | varies |
| Self-hosted, no data leaves your machine | ✅ | ❌ |
| Web dashboard | ✅ | varies |

---

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.0

```bash
# 1. Clone and install
git clone https://github.com/canhta/keyrouter
cd keyrouter
bun install

# 2. Create config from example
cp router.example.json router.json

# 3. Authenticate with a provider (OAuth device flow)
bun run bin/keyrouter.ts auth copilot
# → Opens https://github.com/login/device, enter the code shown

# 4. Start the router
bun run bin/keyrouter.ts
# → http://localhost:3000/v1
```

Point your AI tool at `http://localhost:3000/v1`.

---

## Installation

### From source

```bash
git clone https://github.com/canhta/keyrouter
cd keyrouter
bun install
```

### Docker

```bash
docker compose up
```

### Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

See [Cloud Deploy](#cloud-deploy) for full instructions.

---

## Configuration

Copy `router.example.json` to `router.json` and edit:

```jsonc
{
  "server": {
    "port": 3000,
    "apiKey": "local-secret"   // clients must send Authorization: Bearer <this>
                               // omit entirely to allow unauthenticated access
  },
  "providers": {
    "openai": {
      "apiKey": "sk-..."       // standard API key provider
    },
    "openrouter": {
      "apiKey": "sk-or-..."
    }
    // copilot and codex tokens are stored in data/router.db via `keyrouter auth`
    // no entry needed here for OAuth providers
  },
  "models": {
    "gpt-4o": {
      // upstreamId is optional — defaults to the model key ("gpt-4o")
      "accounts": [
        { "id": "copilot-default", "provider": "copilot" },  // try first
        { "id": "openai-fallback", "provider": "openai" }    // fallback
      ]
    },
    "claude-3-5-sonnet": {
      "upstreamId": "anthropic/claude-3-5-sonnet",   // provider's model ID
      "accounts": [
        { "id": "openrouter-default", "provider": "openrouter" }
      ]
    }
  }
}
```

> **Security:** `router.json` and `data/` are in `.gitignore` by default. Never commit credentials.

---

## Providers

### GitHub Copilot

Requires a GitHub account with an active Copilot subscription.

```bash
bun run bin/keyrouter.ts auth copilot
```

Tokens are stored in `data/router.db` and refreshed automatically. Add `copilot` accounts to any model in your config:

```json
{ "id": "my-copilot-account", "provider": "copilot" }
```

### OpenAI Codex

Requires an active OpenAI account with Codex CLI access.

```bash
bun run bin/keyrouter.ts auth codex
```

### OpenAI

Add your API key to `router.json`:

```json
"providers": { "openai": { "apiKey": "sk-..." } }
```

### OpenRouter

```json
"providers": { "openrouter": { "apiKey": "sk-or-..." } }
```

Any OpenRouter model ID works — set `upstreamId` to the provider slug:

```json
"models": {
  "claude-3-5-sonnet": {
    "upstreamId": "anthropic/claude-3-5-sonnet",
    "accounts": [{ "id": "or", "provider": "openrouter" }]
  }
}
```

---

## CLI Reference

```
keyrouter                     Start the proxy server (default port 3000)
keyrouter auth <provider>     OAuth device flow for a provider
keyrouter help                Show help

Providers:
  copilot     GitHub Copilot (OAuth device flow)
  codex       OpenAI Codex (PKCE device flow)

Environment:
  KEYROUTER_NO_OPEN=1    Skip auto-opening the dashboard in the browser
```

---

## API Compatibility

keyrouter exposes an OpenAI-compatible API:

| Endpoint | Description |
|----------|-------------|
| `GET /v1/models` | List configured models |
| `POST /v1/chat/completions` | Chat completions (streaming + non-streaming) |
| `POST /v1/responses` | OpenAI Responses API (pass-through) |
| `GET /v1/status` | Provider health and lock status |
| `GET /health` | Health check for load balancers / Railway |

Works with any tool that supports `openai-compatible` — OpenCode, Cursor, Continue, Zed, and others.

### OpenCode

```jsonc
// opencode.json
{
  "provider": {
    "keyrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:3000/v1",
        "apiKey": "local-secret"
      }
    }
  }
}
```

> Use `@ai-sdk/openai-compatible`, not `@ai-sdk/openai`. The OpenAI SDK routes newer model IDs to `/v1/responses`.

### Claude Code

```bash
claude config set apiKey local-secret
claude config set baseURL http://localhost:3000/v1
```

---

## Web Dashboard

keyrouter ships with a built-in web dashboard at `http://localhost:3000/dashboard`.

**Features:**
- Live provider status (token expiry, lock state, rate limits)
- 24-hour usage by model
- Trigger OAuth flows for new accounts
- Add/remove models and providers without restarting
- Cloudflare tunnel for remote access (`cloudflared` required)

**First run:** The dashboard will ask you to set an admin password. Sessions last 7 days (rolling).

---

## Account Rotation & Fallback

keyrouter automatically rotates between accounts when one hits a rate limit:

```json
"models": {
  "gpt-4o": {
    "accounts": [
      { "id": "copilot-primary", "provider": "copilot" },
      { "id": "openai-fallback", "provider": "openai" }
    ]
  }
}
```

When `copilot-primary` returns a 429, keyrouter locks it for 30s–30min (exponential backoff) and routes the next request to `openai-fallback`. Locks clear automatically on success.

---

## Cloud Deploy

### Docker

```bash
# Build and run
docker build -t keyrouter .
docker run -p 3000:3000 -v ./data:/app/data -v ./router.json:/app/router.json keyrouter

# Or with docker compose (recommended — mounts data/ for persistence)
docker compose up
```

### Railway

1. Fork this repository
2. Create a new Railway project from the fork
3. Railway auto-detects the `Dockerfile` and `railway.json`
4. Add a Railway Volume mounted at `/app/data` for SQLite persistence
5. Set `PORT` env var if needed (defaults to 3000)
6. Use the Cloudflare tunnel feature in the dashboard for a stable public URL

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `KEYROUTER_NO_OPEN` | — | Set to `1` to skip auto-opening the browser |

---

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run in watch mode (hot-reloads on file changes)
bun --hot run bin/keyrouter.ts

# Type check
bunx tsc --noEmit
```

### Project Structure

```
bin/
  keyrouter.ts          CLI entry point
src/
  index.ts              App setup + route wiring
  config.ts             router.json parsing + hot-reload
  types.ts              All shared interfaces (single source of truth)
  auth/
    store.ts            CredentialStore: resolve + refresh dedup
    session.ts          Dashboard session management
    copilot.ts          GitHub Copilot OAuth device flow
    codex.ts            OpenAI Codex PKCE device flow
    apikey.ts           Static API key credential
  db/
    migrations.ts       SQLite schema versioning
  events/
    bus.ts              DashboardEventBus (SSE pub/sub)
  handlers/             Route handlers (one file per concern)
  providers/            Provider definitions + request headers
  registry/             ModelRegistry with hot-swap
  routing/              Account selection + lock backoff
  translation/          SSE stream transforms
  tunnel/               Cloudflare tunnel lifecycle
  usage/                Usage recording (fire-and-forget)
tests/
  unit/                 Unit tests (no network, in-memory DB)
  integration/          Integration tests (Hono app with mock fetch)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design document.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned providers and features (doctor command, Claude Code OAuth, Gemini CLI OAuth, usage CSV export).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
