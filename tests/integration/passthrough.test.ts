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
import type { RouterConfig, ProviderDefinition, Credential } from '../../src/types.ts'

function makeTestDb(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE model_locks (account_id TEXT NOT NULL, model_id TEXT NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0, last_error INTEGER, PRIMARY KEY (account_id, model_id))`)
  db.run(`CREATE TABLE credentials (provider_id TEXT NOT NULL, account_id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000), PRIMARY KEY (provider_id, account_id))`)
  db.run(`CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, model_id TEXT NOT NULL, provider_id TEXT NOT NULL, account_id TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, streaming INTEGER NOT NULL DEFAULT 0)`)
  return db
}

const testConfig: RouterConfig = {
  models: {
    'gpt-4o': {
      accounts: [{ id: 'mock-account', provider: 'mock' }],
    },
  },
}

const mockProvider: ProviderDefinition = {
  id: 'mock',
  name: 'Mock',
  baseUrl: 'http://localhost:99999',
  requestHeaders: (cred: Credential) => ({
    'Authorization': `Bearer ${cred.value}`,
    'Content-Type': 'application/json',
  }),
}

describe('Request passthrough — unknown fields preserved', () => {
  let app: Hono
  let capturedBody: unknown
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
    app.post('/v1/chat/completions',
      createChatCompletionsHandler(registry, routing, credentialStore, providerRegistry, usageStore)
    )

    originalFetch = globalThis.fetch
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  it('forwards reasoning_opaque and unknown fields to upstream', async () => {
    globalThis.fetch = mock(async (url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string)
      return new Response(JSON.stringify({
        id: 'chatcmpl-x',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const requestBody = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      // Unknown fields that must be forwarded verbatim
      reasoning_effort: 'high',
      reasoning_opaque: 'some-opaque-value',
      custom_field: { nested: true },
      stream_options: { include_usage: true },
    }

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    // Verify all unknown fields were forwarded to upstream
    const body = capturedBody as Record<string, unknown>
    expect(body['reasoning_effort']).toBe('high')
    expect(body['reasoning_opaque']).toBe('some-opaque-value')
    expect(body['custom_field']).toEqual({ nested: true })
    expect(body['stream_options']).toEqual({ include_usage: true })

    // Model should be rewritten to upstreamId (same in this case)
    expect(body['model']).toBe('gpt-4o')
  })

  it('preserves tool_calls in messages verbatim', async () => {
    const messagesWithToolCalls = [
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"temp": 72}',
        tool_call_id: 'call_abc123',
      },
    ]

    globalThis.fetch = mock(async (url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string)
      return new Response(JSON.stringify({
        id: 'chatcmpl-y',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'It is 72F' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: messagesWithToolCalls,
        stream: false,
      }),
    })

    await app.fetch(req)

    const body = capturedBody as { messages: typeof messagesWithToolCalls }
    const assistantMsg = body.messages[1]!
    // tool_call_id and tool_calls must be preserved verbatim
    expect((assistantMsg as unknown as { tool_calls: unknown[] }).tool_calls[0]).toMatchObject({
      id: 'call_abc123',
      type: 'function',
    })
    const toolMsg = body.messages[2]!
    expect((toolMsg as unknown as { tool_call_id: string }).tool_call_id).toBe('call_abc123')
  })
})
