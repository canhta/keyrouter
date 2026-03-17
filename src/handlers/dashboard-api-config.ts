// src/handlers/dashboard-api-config.ts — Config CRUD: PUT/DELETE /dashboard/api/models, /dashboard/api/providers
//
// Config write flow:
//   Zod validate → write router.json.tmp → fs.renameSync (atomic) → 200
//   Any failure   → 400/500, original router.json untouched

import type { Context } from 'hono'
import type { SessionManager } from '../auth/session.ts'
import * as fs from 'node:fs'
import * as path from 'node:path'

const CONFIG_PATH = path.join(process.cwd(), 'router.json')
const CONFIG_TMP = path.join(process.cwd(), 'router.json.tmp')

function requireCsrf(sessionManager: SessionManager, c: Context): Response | null {
  if (!sessionManager.verifyCsrf(c)) {
    return c.json({ error: 'Invalid CSRF token' }, 403) as unknown as Response
  }
  return null
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(CONFIG_TMP, JSON.stringify(config, null, 2), 'utf8')
  fs.renameSync(CONFIG_TMP, CONFIG_PATH)
}

function validateModelEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return 'Model entry must be an object'
  const e = entry as Record<string, unknown>
  if (!e.id || typeof e.id !== 'string') return 'Model id must be a string'
  if (!Array.isArray(e.accounts)) return 'accounts must be an array'
  for (const acc of e.accounts as unknown[]) {
    if (!acc || typeof acc !== 'object') return 'Each account must be an object'
    const a = acc as Record<string, unknown>
    if (!a.id || typeof a.id !== 'string') return 'Account id must be a string'
    if (!a.provider || typeof a.provider !== 'string') return 'Account provider must be a string'
  }
  return null
}

// PUT /dashboard/api/models — upsert a model
export function createUpsertModelHandler(sessionManager: SessionManager) {
  return async (c: Context) => {
    const csrfErr = requireCsrf(sessionManager, c)
    if (csrfErr) return csrfErr

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const validationError = validateModelEntry(body)
    if (validationError) return c.json({ error: validationError }, 400)

    const entry = body as { id: string; upstreamId?: string; accounts: Array<{ id: string; provider: string }> }

    try {
      const config = readConfig()
      const models = (config.models ?? {}) as Record<string, unknown>
      models[entry.id] = {
        upstreamId: entry.upstreamId ?? entry.id,
        accounts: entry.accounts,
      }
      config.models = models
      writeConfig(config)
    } catch (err) {
      console.error('[keyrouter] config write failed:', err)
      return c.json({ error: 'Failed to save config' }, 500)
    }

    return c.json({ ok: true })
  }
}

// DELETE /dashboard/api/models/:id
export function createDeleteModelHandler(sessionManager: SessionManager) {
  return (c: Context) => {
    const csrfErr = requireCsrf(sessionManager, c)
    if (csrfErr) return csrfErr

    const id = c.req.param('id')
    if (!id) return c.json({ error: 'Model id required' }, 400)

    try {
      const config = readConfig()
      const models = (config.models ?? {}) as Record<string, unknown>
      if (!(id in models)) return c.json({ error: `Model '${id}' not found` }, 404)
      delete models[id]
      config.models = models
      writeConfig(config)
    } catch (err) {
      console.error('[keyrouter] config write failed:', err)
      return c.json({ error: 'Failed to save config' }, 500)
    }

    return c.json({ ok: true })
  }
}

function validateProviderEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return 'Provider entry must be an object'
  const e = entry as Record<string, unknown>
  if (!e.id || typeof e.id !== 'string') return 'Provider id must be a string'
  return null
}

// PUT /dashboard/api/providers — upsert a provider config
export function createUpsertProviderHandler(sessionManager: SessionManager) {
  return async (c: Context) => {
    const csrfErr = requireCsrf(sessionManager, c)
    if (csrfErr) return csrfErr

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const validationError = validateProviderEntry(body)
    if (validationError) return c.json({ error: validationError }, 400)

    const entry = body as { id: string; apiKey?: string; baseUrl?: string }

    try {
      const config = readConfig()
      const providers = (config.providers ?? {}) as Record<string, unknown>
      providers[entry.id] = {
        ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      }
      config.providers = providers
      writeConfig(config)
    } catch (err) {
      console.error('[keyrouter] config write failed:', err)
      return c.json({ error: 'Failed to save config' }, 500)
    }

    return c.json({ ok: true })
  }
}

// DELETE /dashboard/api/providers/:id
export function createDeleteProviderHandler(sessionManager: SessionManager) {
  return (c: Context) => {
    const csrfErr = requireCsrf(sessionManager, c)
    if (csrfErr) return csrfErr

    const id = c.req.param('id')
    if (!id) return c.json({ error: 'Provider id required' }, 400)

    try {
      const config = readConfig()
      const providers = (config.providers ?? {}) as Record<string, unknown>
      if (!(id in providers)) return c.json({ error: `Provider '${id}' not found` }, 404)
      delete providers[id]
      config.providers = providers
      writeConfig(config)
    } catch (err) {
      console.error('[keyrouter] config write failed:', err)
      return c.json({ error: 'Failed to save config' }, 500)
    }

    return c.json({ ok: true })
  }
}
