# CEO Plan Review — Dashboard & Cloud Deploy

**Date:** 2026-03-17
**Mode:** EXPANSION
**Scope:** Brutalism dashboard UI + provider limits tracking + endpoint management + tunnel + cloud deploy

---

## All Decisions Made

| Decision | Choice |
|---|---|
| Frontend tech | Tailwind CDN (one `<script>` tag, no build step) |
| Tailwind setup | CDN — `<script src="https://cdn.tailwindcss.com">` |
| Live updates | SSE push via `DashboardEventBus` (reuses existing SSE infra) |
| Tunnel integration | Spawn `cloudflared` automatically; EXPOSE button manages process |
| Endpoint management | Full CRUD (add/edit/remove models+providers via UI, writes router.json atomically) |
| Config validation | Zod (also used for startup config parsing) |
| Dashboard auth | Same port as API (`/dashboard/*` excluded from API auth guard) |
| Cloud deploy target | Railway / Fly.io / Render (persistent server + volume) — NOT Vercel (serverless) |
| Admin password | First-run setup wizard (browser form); stored as bcrypt hash in SQLite |
| Cloud OAuth UX | Dashboard triggers device flow + shows user_code/verification_uri in modal |
| Delight: Auto-open browser | Build now (local mode: open browser on start) |
| Delight: Copy config snippet | Build now |
| Delight: Lock countdown timer | Build now |
| Delight: Dark mode toggle | Build now |
| Delight: Usage CSV export | TODOS.md P3 |
| Config CRUD | Build in same phase as dashboard |

---

## New Components

```
src/
├── ui/
│   └── dashboard.html            # Single HTML file, Tailwind CDN, vanilla JS EventSource
├── tunnel/
│   └── manager.ts                # TunnelManager: spawn/stop cloudflared, parse URL from stdout
├── events/
│   └── bus.ts                    # DashboardEventBus: in-memory pub/sub, no-op if 0 subscribers
├── auth/
│   └── session.ts                # Session management: hash, verify, rate-limit login attempts
├── handlers/
│   ├── dashboard.ts              # GET /dashboard (serve HTML + first-run redirect)
│   ├── dashboard-events.ts       # GET /dashboard/events (SSE stream to browser)
│   └── dashboard-api.ts          # GET|PUT|DELETE /dashboard/api/* (status, CRUD, tunnel, OAuth)
└── db/
    └── migrations.ts             # + provider_limits table, sessions table, login_attempts table
```

New root files:
```
Dockerfile
docker-compose.yml
railway.json
.env.example                      # KEYROUTER_ADMIN_PASSWORD=
```

---

## System Diagram

```
Browser (Dashboard)                    Hono App (Bun, :3000)
        │                                      │
        ├── GET /dashboard ───────────────────►│ serve dashboard.html (redirect /setup if first run)
        │                                      │
        ├── GET /dashboard/setup ─────────────►│ serve setup wizard (if no password set)
        │   POST /dashboard/setup ────────────►│ hash + store password → redirect /dashboard
        │                                      │
        ├── POST /dashboard/login ────────────►│ verify bcrypt → set session cookie
        │                                      │   rate-limit: 5 attempts → 15min lockout
        │                                      │
        ├── GET /dashboard/events ────────────►│ SSE stream (DashboardEventBus)
        │   (EventSource, persistent)          │   subscribers: ChatHandler, LockStore, TunnelMgr
        │                                      │
        ├── GET  /dashboard/api/status ───────►│ provider health + token expiry + lock state
        ├── GET  /dashboard/api/usage ────────►│ 24h aggregated usage by model
        ├── PUT  /dashboard/api/models ───────►│ Zod validate → write router.json atomically
        ├── DELETE /dashboard/api/models/:id ►│ → hot-reload picks up change
        ├── PUT  /dashboard/api/providers ───►│
        ├── DELETE /dashboard/api/providers/:id►
        │                                      │
        ├── POST /dashboard/api/auth/start ──►│ start device flow → return {user_code, uri}
        ├── GET  /dashboard/api/auth/status ─►│ poll: pending | success | expired
        ├── POST /dashboard/api/auth/cancel ─►│ abort polling, clean up
        │                                      │
        ├── POST /dashboard/tunnel/start ─────►│ TunnelManager.start()
        │                                      │   spawn cloudflared, parse URL, SSE push
        └── POST /dashboard/tunnel/stop ──────►│ TunnelManager.stop() + SIGTERM

AI Clients (OpenCode, Cursor)
        │
        ├── POST /v1/chat/completions ────────►│ ChatHandler
        │                                      │   → capture x-ratelimit-* headers
        │                                      │   → write provider_limits (fire-and-forget)
        │                                      │   → publish to DashboardEventBus
        ├── GET /v1/models ──────────────────►│
        ├── GET /v1/status ──────────────────►│
        └── GET /health ─────────────────────►│ {"status":"ok","uptime":N} — Railway health check
```

---

## New SQLite Tables

```sql
-- Provider rate limits (captured from upstream response headers)
CREATE TABLE IF NOT EXISTS provider_limits (
  provider_id   TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  limit_req     INTEGER,      -- x-ratelimit-limit-requests (null if not sent)
  remaining_req INTEGER,      -- x-ratelimit-remaining-requests
  limit_tok     INTEGER,      -- x-ratelimit-limit-tokens
  remaining_tok INTEGER,      -- x-ratelimit-remaining-tokens
  reset_req_at  INTEGER,      -- unix ms when request quota resets
  reset_tok_at  INTEGER,
  captured_at   INTEGER NOT NULL,
  PRIMARY KEY (provider_id, account_id)
);

-- Admin sessions
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

-- Login rate limiting
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  PRIMARY KEY (ip)
);

-- Admin password (bcrypt hash)
-- Stored in the existing schema_version table as a config entry,
-- OR a dedicated settings table:
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- settings('admin_password_hash', '$2b$...')
```

---

## Brutalism Dashboard Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  KEYROUTER  v0.1.0                              [■ RUNNING :3000]  [DARK ☾] │
├───────────────────────────┬──────────────────────┬───────────────────────────┤
│  PROVIDERS                │  USAGE (24h)          │  ENDPOINT                 │
│                           │                       │                           │
│  ┌───────────────────┐   │  ████████████████░░░  │  LOCAL                    │
│  │ COPILOT / default │   │  1,247 req  2.1M tok  │  localhost:3000/v1         │
│  │ ██████████░░ req  │   │                       │  [COPY SNIPPET]            │
│  │ 847 / 1000 /hr    │   │  gpt-4o  ████  834    │                           │
│  │ token: 43min      │   │  o3      ██    321    │  PUBLIC                   │
│  │ [AUTH] [REFRESH]  │   │  gpt-3.5 █      92    │  — not exposed —          │
│  └───────────────────┘   │                       │  [EXPOSE PUBLIC URL]      │
│                           │  TOKENS               │                           │
│  ┌───────────────────┐   │  ████████░░░  83k/    │  MODELS                   │
│  │ OPENAI / main     │   │  100k tok/hr           │                           │
│  │ ∞ unlimited       │   │                       │  gpt-4o → copilot  ✓      │
│  │ token: never      │   │                       │  o3     → copilot  ✓      │
│  └───────────────────┘   │                       │  gpt-3.5→ openai   ✓      │
│                           │                       │  [+ ADD]  [EDIT]  [✕]    │
│  [+ ADD PROVIDER]         │                       │                           │
├───────────────────────────┴───────────────────────┴───────────────────────────┤
│  LIVE LOG                                                           [CLEAR]   │
│  ──────────────────────────────────────────────────────────────────────────  │
│  10:42:01  gpt-4o   copilot/default   200   1.2s  847tok                    │
│  10:42:00  o3       copilot/default   429   LOCKED 23s → retry openai/main  │
│  10:41:58  gpt-4o   copilot/default   200   0.8s  312tok                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Brutalism style rules (Tailwind CDN):**
- `border-4 border-black` — thick borders everywhere, no `rounded-*`
- `font-mono` as base font for the entire dashboard
- `shadow-[4px_4px_0px_#000]` on cards
- High contrast: white bg / black text in light mode; `dark:bg-black dark:text-white dark:border-white` in dark mode
- Status colors: `bg-green-400` (healthy), `bg-yellow-400` (expiring), `bg-red-500` (locked/revoked)
- Buttons: `border-2 border-black bg-white hover:bg-black hover:text-white` — brutalist invert on hover
- Provider rate bar: `<div class="h-5 bg-black" style="width: {pct}%">` inside a bordered container

---

## DashboardEventBus Events

```typescript
type DashboardEvent =
  | { type: 'request';  data: { reqId: string; model: string; provider: string; account: string; status: number; latencyMs: number; tokens: number } }
  | { type: 'lock';     data: { account: string; model: string; lockedUntil: number; attemptCount: number } }
  | { type: 'unlock';   data: { account: string; model: string } }
  | { type: 'token';    data: { provider: string; account: string; expiresAt: number } }  // on refresh
  | { type: 'tunnel';   data: { url: string | null } }          // null = stopped
  | { type: 'config';   data: { models: ModelEntry[] } }        // on hot-reload or CRUD
```

Bus is a simple `Set<(event: DashboardEvent) => void>` of subscriber callbacks. ChatHandler calls `bus.publish(...)` after every request. No-op when set is empty.

---

## OAuth Device Flow via Dashboard

```
User clicks [AUTH COPILOT]
  │
  POST /dashboard/api/auth/start { provider: 'copilot', accountId: 'default' }
  │
  Server calls CopilotOAuth.startDeviceFlow()
    → returns { device_code, user_code, verification_uri, expires_in, interval }
  │
  Response: { user_code: 'XKCD-4892', verification_uri: 'https://github.com/login/device', expiresIn: 900 }
  │
  Dashboard shows modal:
    "1. Open: https://github.com/login/device"
    "2. Enter code: XKCD-4892  [COPY]  [OPEN GITHUB]"
    "Waiting... ⣿"  [CANCEL]
  │
  Browser polls GET /dashboard/api/auth/status/XKCD-4892 every 5s
    │
    ├─ authorization_pending → keep polling
    ├─ slow_down → increase interval by 5s
    ├─ success → CredentialStore.store() → modal: "✓ AUTHORIZED"
    ├─ expired → modal: "✗ CODE EXPIRED — Try again"
    └─ cancel POST /dashboard/api/auth/cancel → abort server-side polling
```

---

## Security Requirements

| Requirement | Implementation |
|---|---|
| Dashboard password hashing | `Bun.password.hash(pw, { algorithm: 'bcrypt' })` |
| Session token | 32 random bytes, hex-encoded, stored in `sessions` table |
| Session cookie | `HttpOnly; SameSite=Strict; Secure` (in prod) |
| Login rate limiting | 5 attempts → 15min lockout, tracked in `login_attempts` by IP |
| CSRF protection | CSRF token in session, checked on all PUT/DELETE/POST dashboard routes |
| XSS in live log | All values set via `element.textContent`, never `innerHTML` |
| Config write | Write to `router.json.tmp` then `fs.renameSync` (atomic) |
| cloudflared not installed | Clear error message + install instructions in UI |
| Admin password in env | Document `KEYROUTER_ADMIN_PASSWORD` as sensitive in Railway |

---

## Cloud Deploy (Railway)

**Files to create:**

`Dockerfile`:
```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["bun", "run", "bin/keyrouter.ts"]
```

`railway.json`:
```json
{
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 10,
    "restartPolicyType": "ON_FAILURE"
  },
  "build": {
    "dockerfilePath": "Dockerfile"
  }
}
```

`docker-compose.yml` (local Docker):
```yaml
services:
  keyrouter:
    build: .
    ports: ["3000:3000"]
    volumes: ["./data:/app/data"]
    environment:
      - KEYROUTER_ADMIN_PASSWORD=${KEYROUTER_ADMIN_PASSWORD}
```

**README deploy button:**
```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/...)
```

**First run on Railway:**
1. No `KEYROUTER_ADMIN_PASSWORD` env var needed — setup wizard handles it
2. User visits `https://keyrouter-xxx.railway.app/dashboard`
3. Redirected to `/dashboard/setup`
4. Creates admin password (stored as bcrypt hash in SQLite)
5. Logs in, dashboard visible

---

## Failure Modes Registry

```
CODEPATH                      | FAILURE           | RESCUED? | USER SEES
------------------------------|-------------------|----------|-----------------------------
TunnelManager.start()         | not installed     | Y        | "cloudflared not found. Install: brew install cloudflared"
                              | exits unexpectedly| Y        | "Tunnel stopped. Restart?"
                              | URL timeout (30s) | Y        | "Tunnel failed to start"
DashboardAuth.login()         | wrong password    | Y        | "Incorrect password (N attempts remaining)"
                              | 5+ attempts       | Y        | "Too many attempts. Try again in 15 minutes"
SetupWizard.submit()          | pw < 8 chars      | Y        | "Password must be at least 8 characters"
ConfigCrud.write()            | Zod validation    | Y        | Inline field errors on form
                              | fs.rename fails   | Y        | "Failed to save config"
OAuthFlow (dashboard)         | device code expiry| Y        | "Code expired. Click AUTH to try again"
                              | user cancels      | Y        | Modal closes, polling stopped
ProviderLimits.capture()      | header absent     | Y (skip) | Nothing (non-fatal)
DashboardEventBus.publish()   | no subscribers    | Y (no-op)| Nothing
CloudDeployFirstRun           | no password set   | Y        | Redirected to /setup wizard
```

**Critical gaps: 0.** All failure modes handled.

---

## NOT in Scope

| Item | Rationale |
|------|-----------|
| Vercel deployment | Serverless incompatible with SQLite + SSE + process management |
| Multi-user access control | Single admin account is sufficient for local/personal use |
| Request replay from dashboard | Interesting but low priority; live log covers debugging |
| ngrok / localtunnel support | cloudflared is free, no account needed; one integration is enough |
| Real-time token usage bar animation | Progressive enhancement; static bar is fine for MVP |
| Slack/email alerts on lock | Out of scope for v1; observability via dashboard is sufficient |

---

## Updated Folder Structure

```
local-router/
├── bin/
│   └── keyrouter.ts
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types.ts                  # + DashboardEvent union type
│   ├── db/
│   │   └── migrations.ts         # + provider_limits, sessions, login_attempts, settings
│   ├── auth/
│   │   ├── store.ts
│   │   ├── copilot.ts
│   │   ├── codex.ts
│   │   ├── apikey.ts
│   │   └── session.ts            # NEW: bcrypt hash/verify, session CRUD, rate limiting
│   ├── events/
│   │   └── bus.ts                # NEW: DashboardEventBus
│   ├── tunnel/
│   │   └── manager.ts            # NEW: TunnelManager (cloudflared lifecycle)
│   ├── providers/
│   │   ├── index.ts
│   │   ├── copilot.ts
│   │   ├── openai.ts
│   │   └── openrouter.ts
│   ├── registry/
│   │   └── index.ts
│   ├── translation/
│   │   ├── stream.ts             # + capture x-ratelimit-* headers
│   │   └── openai-responses.ts
│   ├── routing/
│   │   ├── strategy.ts
│   │   └── lock-store.ts
│   ├── handlers/
│   │   ├── chat-completions.ts   # + publish to DashboardEventBus
│   │   ├── models.ts
│   │   ├── status.ts
│   │   ├── health.ts             # NEW: GET /health (Railway health check)
│   │   ├── dashboard.ts          # NEW: serve HTML + setup redirect
│   │   ├── dashboard-events.ts   # NEW: SSE stream to browser
│   │   └── dashboard-api.ts      # NEW: status, CRUD, auth flows, tunnel control
│   ├── usage/
│   │   └── store.ts
│   └── cli/
│       └── auth.ts
├── src/ui/
│   └── dashboard.html            # NEW: Tailwind CDN, vanilla JS EventSource
├── tests/
│   ├── unit/
│   │   ├── registry.test.ts
│   │   ├── routing.test.ts
│   │   ├── credential-store.test.ts
│   │   ├── stream.test.ts
│   │   ├── event-bus.test.ts     # NEW
│   │   ├── tunnel-manager.test.ts# NEW
│   │   └── dashboard-auth.test.ts# NEW
│   └── integration/
│       ├── chat-completions.test.ts
│       ├── auth-middleware.test.ts
│       └── dashboard-api.test.ts # NEW
├── router.example.json
├── router.json
├── data/
├── Dockerfile                    # NEW
├── docker-compose.yml            # NEW
├── railway.json                  # NEW
├── .env.example                  # NEW
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Delight Opportunities (all confirmed to build)

| # | Feature | Implementation |
|---|---------|----------------|
| 1 | Auto-open browser on local start | `Bun.spawn(['open', url])` after server starts; skip if `KEYROUTER_NO_OPEN=1` |
| 2 | Copy OpenCode config snippet | JS reads current URL + models → generates opencode.json block → `navigator.clipboard.writeText()` |
| 3 | Lock countdown timer | On `lock` SSE event: set JS interval ticking down; on 0 flip card to green |
| 4 | Dark mode toggle | Tailwind `dark:` variant classes; toggle `dark` on `<html>`; persist to `localStorage` |
| 5 | Usage CSV export | `GET /dashboard/api/usage.csv` → TODOS.md P3 |

---

## Completion Summary

```
+====================================================================+
|       MEGA PLAN REVIEW — DASHBOARD + CLOUD DEPLOY                 |
+====================================================================+
| Mode selected        | EXPANSION                                   |
| System Audit         | TODOS P3 dashboard promoted; new cloud      |
|                      | deploy constraint surfaced (Vercel → no)    |
| Step 0               | 6 foundational decisions resolved           |
| Section 1  (Arch)    | 4 obvious fixes; 1 decision (dashboard auth)|
| Section 2  (Errors)  | 10 new error paths; 0 CRITICAL GAPS         |
| Section 3  (Security)| 8 threats mapped; brute-force + CSRF flagged|
| Section 4  (Data/UX) | Config CRUD + device flow flows diagrammed  |
| Section 5  (Quality) | Zod decided; DashboardEventBus pattern       |
| Section 6  (Tests)   | 7 new test files identified                 |
| Section 7  (Perf)    | No concerns at local/single-user scale      |
| Section 8  (Observ)  | Dashboard IS the observability layer        |
| Section 9  (Deploy)  | Dockerfile + railway.json + README button   |
| Section 10 (Future)  | Reversibility: 4/5; multi-user path clear   |
+--------------------------------------------------------------------+
| NOT in scope         | 6 items                                     |
| Error/rescue registry| 11 methods, 0 CRITICAL GAPS                 |
| Failure modes        | All handled                                 |
| TODOS.md updates     | Replaced P3 dashboard w/ Gemini CLI OAuth   |
|                      | (P2) + Usage CSV export (P3)                |
| Delight opportunities| 4 build-now; 1 → TODOS.md                  |
| Diagrams produced    | System arch, dashboard layout, device flow  |
| Unresolved decisions | None                                        |
+====================================================================+
```
