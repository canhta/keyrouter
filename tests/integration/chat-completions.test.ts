import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { ModelRegistry } from '../../src/registry/index.ts'
import { LockStore } from '../../src/routing/lock-store.ts'
import { DefaultRoutingStrategy } from '../../src/routing/strategy.ts'
import { SqliteCredentialStore } from '../../src/auth/store.ts'
import { ProviderRegistry } from '../../src/providers/index.ts'
import { UsageStore } from '../../src/usage/store.ts'
import { createChatCompletionsHandler } from '../../src/handlers/chat-completions.ts'
import type { RouterConfig } from '../../src/types.ts'

// ── Test DB setup ─────────────────────────────────────────────────────────────

function makeTestDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE model_locks (
      account_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error INTEGER,
      PRIMARY KEY (account_id, model_id)
    )
  `)
  db.run(`
    CREATE TABLE credentials (
      provider_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      PRIMARY KEY (provider_id, account_id)
    )
  `)
  db.run(`
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      streaming INTEGER NOT NULL DEFAULT 0
    )
  `)
  return db
}

// ── SSE stream helpers ────────────────────────────────────────────────────────

function makeSSEResponse(chunks: object[], includeUsage = false): Response {
  const lines: string[] = []
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  if (includeUsage) {
    lines.push(
      `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
    )
  }
  lines.push('data: [DONE]\n\n')

  const body = lines.join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

// ── Test setup ────────────────────────────────────────────────────────────────

const testConfig: RouterConfig = {
  server: { port: 3099 },
  providers: {
    mock: { apiKey: 'mock-key' },
  },
  models: {
    'gpt-4o': {
      accounts: [
        { id: 'mock-primary', provider: 'mock' },
        { id: 'mock-secondary', provider: 'mock' },
      ],
    },
  },
}

// Register a mock provider
import type { Credential, ProviderDefinition } from '../../src/types.ts'

const mockProvider: ProviderDefinition = {
  id: 'mock',
  name: 'Mock Provider',
  baseUrl: 'http://localhost:99999',
  requestHeaders: (cred: Credential) => ({
    'Authorization': `Bearer ${cred.value}`,
    'Content-Type': 'application/json',
  }),
}

describe('POST /v1/chat/completions', () => {
  let app: Hono
  let db: Database
  let credentialStore: SqliteCredentialStore
  let lockStore: LockStore
  let routing: DefaultRoutingStrategy
  let providerRegistry: ProviderRegistry
  let usageStore: UsageStore
  let originalFetch: typeof globalThis.fetch

  beforeAll(() => {
    db = makeTestDb()
    credentialStore = new SqliteCredentialStore(db)
    lockStore = new LockStore(db)
    routing = new DefaultRoutingStrategy(lockStore)
    providerRegistry = new ProviderRegistry()
    ;(providerRegistry as unknown as { providers: Map<string, ProviderDefinition> }).providers.set('mock', mockProvider)
    usageStore = new UsageStore(db)

    const registry = new ModelRegistry(testConfig)

    // Save mock credentials
    credentialStore.save({
      providerId: 'mock',
      accountId: 'mock-primary',
      type: 'api_key',
      value: 'mock-key-primary',
    })
    credentialStore.save({
      providerId: 'mock',
      accountId: 'mock-secondary',
      type: 'api_key',
      value: 'mock-key-secondary',
    })

    app = new Hono()
    app.post(
      '/v1/chat/completions',
      createChatCompletionsHandler(registry, routing, credentialStore, providerRegistry, usageStore)
    )

    originalFetch = globalThis.fetch
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  it('returns 404 for unknown model', async () => {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unknown-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(404)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  it('returns 400 for missing model field', async () => {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)
  })

  it('streams SSE response from mock provider', async () => {
    const chunks = [
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ delta: { content: 'Hello' }, index: 0, finish_reason: null }] },
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ delta: { content: ' world' }, index: 0, finish_reason: 'stop' }] },
    ]

    globalThis.fetch = mock(async () => makeSSEResponse(chunks, true)) as unknown as typeof fetch

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const text = await res.text()
    expect(text).toContain('Hello')
    expect(text).toContain('data: [DONE]')
  })

  it('locks primary account on 429 and tries secondary', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      if (callCount === 1) {
        // First call → 429
        return new Response('', { status: 429 })
      }
      // Second call → success
      return makeSSEResponse([
        { id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [{ delta: { content: 'Fallback' }, index: 0, finish_reason: 'stop' }] },
      ], true)
    }) as unknown as typeof fetch

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(200)
    expect(callCount).toBe(2)

    const text = await res.text()
    expect(text).toContain('Fallback')
  })

  it('returns 503 when provider returns HTML', async () => {
    globalThis.fetch = mock(async () => new Response('<html><body>Error</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(503)
  })

  it('handles non-streaming (stream:false) correctly', async () => {
    const jsonResponse = {
      id: 'chatcmpl-nonstream',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'Non-stream response' }, finish_reason: 'stop', index: 0 }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }

    globalThis.fetch = mock(async () => new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(200)
    const json = await res.json() as typeof jsonResponse
    expect(json.choices[0]!.message.content).toBe('Non-stream response')
  })
})
