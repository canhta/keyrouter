import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { ModelRegistry } from '../../src/registry/index.ts'
import { LockStore } from '../../src/routing/lock-store.ts'
import { DefaultRoutingStrategy } from '../../src/routing/strategy.ts'
import { SqliteCredentialStore } from '../../src/auth/store.ts'
import { ProviderRegistry } from '../../src/providers/index.ts'
import { UsageStore } from '../../src/usage/store.ts'
import { createResponsesHandler } from '../../src/handlers/responses.ts'
import type { RouterConfig, ProviderDefinition, Credential } from '../../src/types.ts'

function makeTestDb(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE model_locks (account_id TEXT NOT NULL, model_id TEXT NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0, last_error INTEGER, PRIMARY KEY (account_id, model_id))`)
  db.run(`CREATE TABLE credentials (provider_id TEXT NOT NULL, account_id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000), PRIMARY KEY (provider_id, account_id))`)
  db.run(`CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, model_id TEXT NOT NULL, provider_id TEXT NOT NULL, account_id TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, streaming INTEGER NOT NULL DEFAULT 0)`)
  return db
}

const testConfig: RouterConfig = {
  models: { 'gpt-4o': { accounts: [{ id: 'mock-account', provider: 'mock' }] } },
}

const mockProvider: ProviderDefinition = {
  id: 'mock', name: 'Mock', baseUrl: 'http://x',
  requestHeaders: (cred: Credential) => ({ 'Authorization': `Bearer ${cred.value}`, 'Content-Type': 'application/json' }),
}

describe('POST /v1/responses', () => {
  let app: Hono
  let originalFetch: typeof globalThis.fetch

  beforeAll(() => {
    const db = makeTestDb()
    const credentialStore = new SqliteCredentialStore(db)
    const lockStore = new LockStore(db)
    const routing = new DefaultRoutingStrategy(lockStore)
    const providerRegistry = new ProviderRegistry()
    ;(providerRegistry as unknown as { providers: Map<string, ProviderDefinition> }).providers.set('mock', mockProvider)
    const usageStore = new UsageStore(db)
    const registry = new ModelRegistry(testConfig)
    credentialStore.save({ providerId: 'mock', accountId: 'mock-account', type: 'api_key', value: 'key' })

    app = new Hono()
    app.post('/v1/responses', createResponsesHandler(registry, routing, credentialStore, providerRegistry, usageStore))
    originalFetch = globalThis.fetch
  })

  afterAll(() => { globalThis.fetch = originalFetch })

  it('returns 501 for unsupported event types', async () => {
    const req = new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [
          { type: 'message', role: 'user', content: 'search for something' },
          { type: 'web_search_call' },
        ],
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(501)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('not_implemented')
  })

  it('converts input[] to messages and returns Responses format', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      id: 'chatcmpl-r1',
      object: 'chat.completion',
      created: 1720000000,
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'The answer is 42' }, finish_reason: 'stop', index: 0 }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const req = new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        instructions: 'Be concise',
        input: [{ type: 'message', role: 'user', content: 'What is the answer?' }],
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    const json = await res.json() as { object: string; output: Array<{ type: string; content: Array<{ text: string }> }>; status: string }
    expect(json.object).toBe('response')
    expect(json.status).toBe('completed')
    expect(json.output[0]!.type).toBe('message')
    expect(json.output[0]!.content[0]!.text).toBe('The answer is 42')
  })

  it('returns 404 for unknown model', async () => {
    const req = new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unknown', input: [] }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(404)
  })
})
