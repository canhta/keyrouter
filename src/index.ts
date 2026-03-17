// src/index.ts — Hono app + startup
//
// Called by bin/keyrouter.ts when no auth subcommand is given.

import { Hono } from 'hono'
import { openDatabase } from './db/migrations.ts'
import { loadConfig, watchConfig } from './config.ts'
import { ModelRegistry } from './registry/index.ts'
import { ProviderRegistry } from './providers/index.ts'
import { SqliteCredentialStore } from './auth/store.ts'
import { LockStore } from './routing/lock-store.ts'
import { DefaultRoutingStrategy } from './routing/strategy.ts'
import { UsageStore } from './usage/store.ts'
import { createModelsHandler } from './handlers/models.ts'
import { createStatusHandler } from './handlers/status.ts'
import { createChatCompletionsHandler } from './handlers/chat-completions.ts'
import { createResponsesHandler } from './handlers/responses.ts'
import { CopilotOAuth } from './auth/copilot.ts'
import { CodexOAuth } from './auth/codex.ts'

export async function startServer(): Promise<void> {
  // ── Load config + DB ──────────────────────────────────────────────────
  const config = loadConfig()
  const db = openDatabase()

  // ── Build dependencies ────────────────────────────────────────────────
  const registry = new ModelRegistry(config)
  const providerRegistry = new ProviderRegistry()
  const credentialStore = new SqliteCredentialStore(db)

  // ── Register OAuth providers ──────────────────────────────────────────
  credentialStore.registerOAuthProvider('copilot', new CopilotOAuth(credentialStore))
  credentialStore.registerOAuthProvider('codex', new CodexOAuth(credentialStore))
  const lockStore = new LockStore(db)
  const routing = new DefaultRoutingStrategy(lockStore)
  const usageStore = new UsageStore(db)

  // ── Hot-reload config ─────────────────────────────────────────────────
  watchConfig(registry)

  // ── Build Hono app ────────────────────────────────────────────────────
  const app = new Hono()

  // Auth middleware (optional API key check)
  const serverApiKey = config.server?.apiKey
  if (serverApiKey) {
    app.use('/v1/*', async (c, next) => {
      const authHeader = c.req.header('authorization') ?? ''
      const incoming = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader

      // Use timing-safe comparison
      const encoder = new TextEncoder()
      const a = encoder.encode(incoming)
      const b = encoder.encode(serverApiKey)

      // Constant-time comparison (different lengths = definitely not equal)
      let mismatch = a.length !== b.length ? 1 : 0
      const len = Math.min(a.length, b.length)
      for (let i = 0; i < len; i++) {
        mismatch |= a[i]! ^ b[i]!
      }

      if (mismatch !== 0) {
        return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: '401' } }, 401)
      }

      return next()
    })
  }

  // ── Routes ────────────────────────────────────────────────────────────
  app.get('/v1/models', createModelsHandler(registry))
  app.get('/v1/status', createStatusHandler(registry, lockStore, credentialStore))
  app.post(
    '/v1/chat/completions',
    createChatCompletionsHandler(registry, routing, credentialStore, providerRegistry, usageStore)
  )
  app.post(
    '/v1/responses',
    createResponsesHandler(registry, routing, credentialStore, providerRegistry, usageStore)
  )

  // ── Start server ──────────────────────────────────────────────────────
  const port = config.server?.port ?? 3000

  printBanner(config, port)

  try {
    Bun.serve({
      port,
      fetch: app.fetch,
    })
  } catch (err: unknown) {
    const e = err as { code?: string }
    if (e?.code === 'EADDRINUSE') {
      console.error(`\n[keyrouter] ERROR: Port ${port} is already in use.`)
      console.error(`Set server.port in router.json to use a different port.\n`)
      process.exit(1)
    }
    throw err
  }

  console.log(`[keyrouter] listening on http://localhost:${port}`)
}

function printBanner(config: import('./types.ts').RouterConfig, port: number): void {
  const models = Object.keys(config.models ?? {})
  const providers = new Set(
    Object.values(config.models ?? {}).flatMap(m => m.accounts.map(a => a.provider))
  )

  console.log(`
╔══════════════════════════════════════════════════════╗
║                    keyrouter v0.1.0                  ║
╚══════════════════════════════════════════════════════╝

  Port:      ${port}
  Models:    ${models.length > 0 ? models.join(', ') : '(none)'}
  Providers: ${providers.size > 0 ? Array.from(providers).join(', ') : '(none)'}

  OpenCode config:
    {
      "provider": {
        "keyrouter": {
          "npm": "@ai-sdk/openai-compatible",
          "options": {
            "baseURL": "http://localhost:${port}/v1",
            "apiKey": "${config.server?.apiKey ?? 'local-secret'}"
          }
        }
      }
    }
`)
}
