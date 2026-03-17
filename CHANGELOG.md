# Changelog

All notable changes to keyrouter are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-03-17

### Added

- **Core proxy** — OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints
- **GitHub Copilot OAuth** — device flow + auto-refresh (`keyrouter auth copilot`)
- **OpenAI Codex OAuth** — PKCE device flow + auto-refresh (`keyrouter auth codex`)
- **OpenAI / OpenRouter** — API key provider support
- **Account rotation** — multiple accounts per model, unlocked accounts tried first
- **Lock backoff** — 30s → 60s → 5m → 30m on 429/5xx, auto-clears on success
- **Usage recording** — fire-and-forget SQLite writes, queryable via `/v1/status`
- **Hot-reload** — edit `router.json` without restarting; registry swaps atomically
- **OpenAI Responses API** — `/v1/responses` pass-through for tools that require it
- **Web dashboard** — `/dashboard` with provider status, usage stats, OAuth flows, config CRUD, Cloudflare tunnel
- **SSE live events** — dashboard receives real-time request/lock/config events
- **Docker + Railway** — `Dockerfile`, `docker-compose.yml`, `railway.json`
- **111 tests** — unit + integration covering all routing, OAuth, and dashboard paths
