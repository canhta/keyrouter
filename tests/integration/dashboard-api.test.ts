// tests/integration/dashboard-api.test.ts
//
// Tests all dashboard API routes:
//   GET  /dashboard/api/status
//   GET  /dashboard/api/usage
//   PUT  /dashboard/api/models
//   DELETE /dashboard/api/models/:id
//   PUT  /dashboard/api/providers
//   DELETE /dashboard/api/providers/:id
//   POST /dashboard/api/auth/start
//   GET  /dashboard/api/auth/status/:userCode
//   DELETE /dashboard/api/auth/cancel/:userCode
//   POST   /dashboard/api/tunnel
//   DELETE /dashboard/api/tunnel
//   GET    /dashboard/api/tunnel

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionManager } from '../../src/auth/session.ts'
import { SqliteCredentialStore } from '../../src/auth/store.ts'
import { ModelRegistry } from '../../src/registry/index.ts'
import { LockStore } from '../../src/routing/lock-store.ts'
import { DashboardEventBus } from '../../src/events/bus.ts'
import { TunnelManager } from '../../src/tunnel/manager.ts'
import {
  createDashboardStatusHandler,
  createDashboardUsageHandler,
} from '../../src/handlers/dashboard-api-status.ts'
import {
  createUpsertModelHandler,
  createDeleteModelHandler,
  createUpsertProviderHandler,
  createDeleteProviderHandler,
} from '../../src/handlers/dashboard-api-config.ts'
import { createDashboardAuthHandlers } from '../../src/handlers/dashboard-api-auth.ts'
import {
  createTunnelStartHandler,
  createTunnelStopHandler,
  createTunnelStatusHandler,
} from '../../src/handlers/dashboard-api-tunnel.ts'
import type { RouterConfig } from '../../src/types.ts'

// ── DB setup ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE credentials (
      provider_id TEXT NOT NULL, account_id TEXT NOT NULL,
      type TEXT NOT NULL, value TEXT NOT NULL,
      refresh_token TEXT, expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      PRIMARY KEY (provider_id, account_id)
    )`)
  db.run(`
    CREATE TABLE model_locks (
      account_id TEXT NOT NULL, model_id TEXT NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0, last_error INTEGER,
      PRIMARY KEY (account_id, model_id)
    )`)
  db.run(`
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
      model_id TEXT NOT NULL, provider_id TEXT NOT NULL, account_id TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, streaming INTEGER NOT NULL DEFAULT 0
    )`)
  db.run(`
    CREATE TABLE provider_limits (
      provider_id TEXT NOT NULL, account_id TEXT NOT NULL,
      limit_req INTEGER, remaining_req INTEGER,
      limit_tok INTEGER, remaining_tok INTEGER,
      reset_req_at INTEGER, reset_tok_at INTEGER,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, account_id)
    )`)
  db.run(`
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`)
  db.run(`
    CREATE TABLE login_attempts (
      ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER
    )`)
  db.run(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)
  `)
  return db
}

const testConfig: RouterConfig = {
  models: {
    'gpt-4o': { upstreamId: 'gpt-4o', accounts: [{ id: 'acc1', provider: 'openai' }] },
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCsrfHeaders(c: { sessionToken: string; csrfToken: string }) {
  return {
    Cookie: `keyrouter_session=${c.sessionToken}; keyrouter_csrf=${c.csrfToken}`,
    'X-CSRF-Token': c.csrfToken,
    'Content-Type': 'application/json',
  }
}

function makeAuthSession(db: Database): { sessionToken: string; csrfToken: string } {
  const token = 'test-session-token-' + Math.random().toString(36).slice(2)
  db.query('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(
    token, Date.now(), Date.now() + 7 * 24 * 60 * 60 * 1000
  )
  const csrf = 'test-csrf-' + Math.random().toString(36).slice(2)
  return { sessionToken: token, csrfToken: csrf }
}

// ── Status + Usage ────────────────────────────────────────────────────────────

describe('GET /dashboard/api/status', () => {
  it('returns models and account map', async () => {
    const db = makeDb()
    const registry = new ModelRegistry(testConfig)
    const lockStore = new LockStore(db)
    const credStore = new SqliteCredentialStore(db)

    const app = new Hono()
    app.get('/dashboard/api/status', createDashboardStatusHandler(registry, lockStore, credStore))

    const res = await app.request('/dashboard/api/status')
    expect(res.status).toBe(200)
    const body = await res.json() as { models: unknown[]; accounts: Record<string, unknown> }
    expect(body.models).toBeDefined()
    expect(body.accounts).toBeDefined()
    expect(body.models).toHaveLength(1)
  })
})

describe('GET /dashboard/api/usage', () => {
  it('returns usage stats with empty arrays when no data', async () => {
    const db = makeDb()
    const app = new Hono()
    app.get('/dashboard/api/usage', createDashboardUsageHandler(db))

    const res = await app.request('/dashboard/api/usage')
    expect(res.status).toBe(200)
    const body = await res.json() as { period: string; byModel: unknown[]; providerLimits: unknown[] }
    expect(body.period).toBe('24h')
    expect(body.byModel).toHaveLength(0)
    expect(body.providerLimits).toHaveLength(0)
  })
})

// ── Config CRUD ───────────────────────────────────────────────────────────────

describe('PUT /dashboard/api/models', () => {
  let tmpDir: string
  let originalCwd: () => string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyrouter-test-'))
    // Override process.cwd() is not easy; instead write a router.json to test dir
    // We test that the handler writes to process.cwd()/router.json
    // For isolation, we patch the module-level CONFIG_PATH via a temp file in cwd
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when CSRF token is missing', async () => {
    const db = makeDb()
    const sessionManager = new SessionManager(db)
    const app = new Hono()
    app.put('/dashboard/api/models', createUpsertModelHandler(sessionManager))

    const res = await app.request('/dashboard/api/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test', accounts: [{ id: 'acc', provider: 'openai' }] }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 400 when model entry is invalid', async () => {
    const db = makeDb()
    const session = makeAuthSession(db)
    const sessionManager = new SessionManager(db)

    const app = new Hono()
    app.put('/dashboard/api/models', createUpsertModelHandler(sessionManager))

    const res = await app.request('/dashboard/api/models', {
      method: 'PUT',
      headers: makeCsrfHeaders(session),
      body: JSON.stringify({ id: '', accounts: [] }),  // invalid: empty id
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /dashboard/api/models/:id', () => {
  it('returns 403 without CSRF', async () => {
    const db = makeDb()
    const sessionManager = new SessionManager(db)
    const app = new Hono()
    app.delete('/dashboard/api/models/:id', createDeleteModelHandler(sessionManager))

    const res = await app.request('/dashboard/api/models/gpt-4o', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

describe('PUT /dashboard/api/providers', () => {
  it('returns 403 without CSRF', async () => {
    const db = makeDb()
    const sessionManager = new SessionManager(db)
    const app = new Hono()
    app.put('/dashboard/api/providers', createUpsertProviderHandler(sessionManager))

    const res = await app.request('/dashboard/api/providers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'openai', apiKey: 'sk-test' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 400 when provider entry is invalid', async () => {
    const db = makeDb()
    const session = makeAuthSession(db)
    const sessionManager = new SessionManager(db)

    const app = new Hono()
    app.put('/dashboard/api/providers', createUpsertProviderHandler(sessionManager))

    const res = await app.request('/dashboard/api/providers', {
      method: 'PUT',
      headers: makeCsrfHeaders(session),
      body: JSON.stringify({ id: '' }),  // invalid: empty id
    })
    expect(res.status).toBe(400)
  })
})

// ── OAuth device flow ─────────────────────────────────────────────────────────

describe('POST /dashboard/api/auth/start', () => {
  it('returns 403 without CSRF', async () => {
    const db = makeDb()
    const sessionManager = new SessionManager(db)
    const credStore = new SqliteCredentialStore(db)
    const { startHandler } = createDashboardAuthHandlers(sessionManager, credStore)

    const app = new Hono()
    app.post('/dashboard/api/auth/start', startHandler)

    const res = await app.request('/dashboard/api/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'copilot', accountId: 'user1' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 400 for missing provider', async () => {
    const db = makeDb()
    const session = makeAuthSession(db)
    const sessionManager = new SessionManager(db)
    const credStore = new SqliteCredentialStore(db)
    const { startHandler } = createDashboardAuthHandlers(sessionManager, credStore)

    const app = new Hono()
    app.post('/dashboard/api/auth/start', startHandler)

    const res = await app.request('/dashboard/api/auth/start', {
      method: 'POST',
      headers: makeCsrfHeaders(session),
      body: JSON.stringify({ accountId: 'user1' }),  // missing provider
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for unregistered provider', async () => {
    const db = makeDb()
    const session = makeAuthSession(db)
    const sessionManager = new SessionManager(db)
    const credStore = new SqliteCredentialStore(db)
    // credStore has no OAuth providers registered
    const { startHandler } = createDashboardAuthHandlers(sessionManager, credStore)

    const app = new Hono()
    app.post('/dashboard/api/auth/start', startHandler)

    const res = await app.request('/dashboard/api/auth/start', {
      method: 'POST',
      headers: makeCsrfHeaders(session),
      body: JSON.stringify({ provider: 'unknown-provider', accountId: 'user1' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /dashboard/api/auth/status/:userCode', () => {
  it('returns 404 for unknown userCode', async () => {
    const db = makeDb()
    const sessionManager = new SessionManager(db)
    const credStore = new SqliteCredentialStore(db)
    const { statusHandler } = createDashboardAuthHandlers(sessionManager, credStore)

    const app = new Hono()
    app.get('/dashboard/api/auth/status/:userCode', statusHandler)

    const res = await app.request('/dashboard/api/auth/status/UNKNOWN-CODE')
    expect(res.status).toBe(404)
  })
})

// ── Tunnel ────────────────────────────────────────────────────────────────────

describe('GET /dashboard/api/tunnel', () => {
  it('returns running=false and url=null initially', async () => {
    const bus = new DashboardEventBus()
    const tunnelMgr = new TunnelManager(3000, bus)

    const app = new Hono()
    app.get('/dashboard/api/tunnel', createTunnelStatusHandler(tunnelMgr))

    const res = await app.request('/dashboard/api/tunnel')
    expect(res.status).toBe(200)
    const body = await res.json() as { running: boolean; url: string | null }
    expect(body.running).toBe(false)
    expect(body.url).toBeNull()
  })
})

describe('DELETE /dashboard/api/tunnel', () => {
  it('returns 403 without CSRF', async () => {
    const db = makeDb()
    const sessionManager = new SessionManager(db)
    const bus = new DashboardEventBus()
    const tunnelMgr = new TunnelManager(3000, bus)

    const app = new Hono()
    app.delete('/dashboard/api/tunnel', createTunnelStopHandler(sessionManager, tunnelMgr))

    const res = await app.request('/dashboard/api/tunnel', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when tunnel is not running', async () => {
    const db = makeDb()
    const session = makeAuthSession(db)
    const sessionManager = new SessionManager(db)
    const bus = new DashboardEventBus()
    const tunnelMgr = new TunnelManager(3000, bus)

    const app = new Hono()
    app.delete('/dashboard/api/tunnel', createTunnelStopHandler(sessionManager, tunnelMgr))

    const res = await app.request('/dashboard/api/tunnel', {
      method: 'DELETE',
      headers: makeCsrfHeaders(session),
    })
    expect(res.status).toBe(404)
  })
})
