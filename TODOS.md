# TODOS

## P2: keyrouter doctor command

**What:** CLI subcommand (`keyrouter doctor`) that validates config, tests each provider connection, and reports token freshness.

**Why:** Saves debugging time when something silently breaks. Answers common "why isn't this working" questions in one command. Particularly useful after token expiry or config changes.

**Pros:** Excellent onboarding experience; easy to run before a coding session; useful for CI health checks.

**Cons:** Medium effort; `GET /v1/status` + `keyrouter auth` CLI cover the immediate debugging need.

**Context:** Should check: (1) router.json parses and validates, (2) data/router.db exists and schema is current, (3) each configured provider has a stored token that isn't expired, (4) provider is reachable (optional HTTP check). Output should be color-coded: green=ready, yellow=expiring soon, red=needs auth.

**Effort:** M | **Depends on:** `keyrouter auth` CLI working, `/v1/status` endpoint stable

---

## P2: Claude Code OAuth provider

**What:** `OAuthProvider` implementation for Anthropic's Claude Code CLI tool.

**Why:** Claude Code uses subscription-based OAuth auth — the same pattern as Copilot and Codex. Standard API-key gateways can't handle it. This makes keyrouter work for Claude Code users.

**Pros:** Covers another major subscription-backed provider. Follows the same `OAuthProvider` interface — minimal new patterns to learn.

**Cons:** Requires testing against a real Claude Code subscription to verify the flow.

**Context:** Reference implementation: `CLIProxyAPI/internal/auth/antigravity/auth.go`. Token endpoint: `https://api.anthropic.com/v1/oauth/token`. Same device flow pattern as `src/auth/copilot.ts`. The `OAuthProvider` interface in `src/types.ts` already supports it — just needs a new `src/auth/claude-code.ts` implementation and a new entry in `src/providers/claude-code.ts`.

**Effort:** M | **Depends on:** Core OAuth pattern stable (Phase 3 complete — Codex OAuth working)

---

## P2: Gemini CLI OAuth provider

**What:** `OAuthProvider` implementation for Google's Gemini CLI tool.

**Why:** Gemini CLI uses subscription-based OAuth auth — same pattern as Copilot and Codex. Standard API-key gateways can't handle it.

**Pros:** Covers another major subscription-backed provider. Reference in CLIProxyAPI. Follows the same `OAuthProvider` interface.

**Cons:** Requires testing against a real Gemini CLI subscription.

**Context:** Reference: `CLIProxyAPI/internal/auth/` (Google/Gemini OAuth). Same device flow pattern as `src/auth/copilot.ts`. Needs `src/auth/gemini.ts` + `src/providers/gemini.ts`.

**Effort:** M | **Depends on:** Core OAuth pattern stable (Phase 3 complete)

---

## P3: Usage export to CSV

**What:** `GET /dashboard/api/usage.csv` streams the SQLite usage table as a downloadable CSV file.

**Why:** Power users want to analyze AI usage in Excel/Google Sheets. Useful for cost tracking and debugging request patterns.

**Pros:** Zero new data model work — reads existing `usage` table. ~20 min to implement.

**Cons:** Low urgency; the live log covers immediate debugging needs.

**Context:** Stream the SQLite `usage` table as CSV via Hono response with `Content-Disposition: attachment`. Add an EXPORT CSV button to the usage section of the dashboard.

**Effort:** S | **Depends on:** Dashboard and UsageStore exist
