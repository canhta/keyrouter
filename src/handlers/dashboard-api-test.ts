// src/handlers/dashboard-api-test.ts — Test connection to the first available model

import type { Context } from 'hono'
import type { ModelRegistry } from '../registry/index.ts'
import type { SqliteCredentialStore } from '../auth/store.ts'
import type { ProviderRegistry } from '../providers/index.ts'

export function createTestConnectionHandler(
  registry: ModelRegistry,
  credentialStore: SqliteCredentialStore,
  providerRegistry: ProviderRegistry
) {
  return async (c: Context) => {
    try {
      // Get the first model from registry
      const models = registry.list()
      const model = models[0]
      if (!model) {
        return c.json({ ok: false, error: 'No models configured' })
      }

      // Get the first account for that model
      const account = model.accounts[0]
      if (!account) {
        return c.json({ ok: false, error: `No accounts configured for model ${model.id}` })
      }

      // Peek at credentials to check they exist (without refresh)
      const peek = credentialStore.peek(account.providerId, account.id)
      if (!peek.hasCredential) {
        return c.json({
          ok: false,
          error: `No credential found for ${account.providerId}/${account.id}. Run: keyrouter auth ${account.providerId}`,
        })
      }

      // Get the provider definition
      const provider = providerRegistry.get(account.providerId)
      if (!provider) {
        return c.json({ ok: false, error: `Unknown provider: ${account.providerId}`, model: model.id })
      }

      // Resolve the real credential (with refresh if needed)
      const cred = await credentialStore.resolve(account.providerId, account.id)

      // Make a real test request with 10s timeout
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)

      const startMs = Date.now()
      let response: Response
      try {
        response = await fetch(provider.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...provider.requestHeaders(cred),
          },
          body: JSON.stringify({
            model: model.upstreamId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }

      const latencyMs = Date.now() - startMs

      if (response.ok) {
        return c.json({ ok: true, model: model.id, provider: account.providerId, latencyMs })
      }

      const errorText = await response.text().catch(() => `HTTP ${response.status}`)
      return c.json({
        ok: false,
        error: `Provider returned ${response.status}: ${errorText}`,
        model: model.id,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: message })
    }
  }
}
