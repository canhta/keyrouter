# Memory Index

## Project
- [project_goal.md](./project_goal.md) — What the user is building: lightweight self-hosted AI router with subscription auth + OpenCode compatibility

## Source Findings (confirmed from local repos)
- [findings_cliproxyapi.md](./findings_cliproxyapi.md) — **ORIGINAL Go implementation**: Codex PKCE OAuth (ClientID + endpoints confirmed), Antigravity OAuth, conductor rotation/cooldown logic, translator registry pattern, Gemini schema cleaning, YAML config format
- [findings_9router.md](./findings_9router.md) — JS port of CLIProxyAPI: adds GitHub Copilot, Kiro, cursor (gRPC Connect), ollama; uses SQLite + Next.js dashboard; primary reference for Copilot OAuth
- [findings_opencode.md](./findings_opencode.md) — SDK stack, dual-endpoint routing, multi-turn behavior, streaming format, custom provider config from opencode source
- [findings_portkey.md](./findings_portkey.md) — Provider abstraction pattern, fallback logic, virtual keys, streaming normalization from portkey source

## Analysis
- [analysis_compatibility.md](./analysis_compatibility.md) — Cross-project comparison, root causes of incompatibility, tested hypotheses (H1–H5)

## Architecture
- [architecture_modules.md](./architecture_modules.md) — Recommended architecture, 6 modules, TypeScript interfaces, folder structure, router.json schema
- [implementation_plan.md](./implementation_plan.md) — MVP scope, 6-phase build plan, risks and mitigations
