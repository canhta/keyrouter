---
name: Router project goal
description: What the user is building and why — lightweight self-hosted AI router combining subscription auth with OpenCode compatibility
type: project
---

User is building a lightweight self-hosted AI router in TypeScript/Node.js.

**Goal:** Combine subscription-backed provider auth with clean OpenAI-compatible API for coding tools.

**Requirements:**
- Support subscription-backed providers (GitHub Copilot OAuth, OpenAI Codex OAuth) — not just API keys
- Expose clean `/v1/chat/completions` (and optionally `/v1/responses`) for downstream clients
- OpenRouter/Portkey-style routing: fallback, account rotation, provider abstraction
- Full compatibility with OpenCode and Vercel AI SDK clients

**Why:** Subscription-backed providers (Copilot, Codex) require OAuth device flows managed by the router itself. Standard API-key-only gateways (Portkey) cannot handle this.

**How to apply:** All implementation decisions should prioritize (1) Copilot/Codex OAuth working reliably, (2) full OpenCode compatibility, (3) minimal complexity over feature completeness.
