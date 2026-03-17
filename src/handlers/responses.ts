// src/handlers/responses.ts — POST /v1/responses
//
// Translates between the Responses API format (used by Codex/gpt-5+) and
// the Chat Completions format used internally.
//
// Unsupported event types (web_search_call, code_interpreter_call, etc.)
// return 501 Not Implemented per the plan.

import type { Context } from 'hono'
import type { ModelRegistry } from '../registry/index.ts'
import type { RoutingStrategy } from '../types.ts'
import { CredentialNotFoundError, OAuthRevokedError } from '../types.ts'
import type { SqliteCredentialStore } from '../auth/store.ts'
import type { ProviderRegistry } from '../providers/index.ts'
import type { UsageStore } from '../usage/store.ts'
import {
  type ResponsesRequest,
  inputToMessages,
  findUnsupportedType,
  wrapChatResponse,
} from '../translation/openai-responses.ts'

export function createResponsesHandler(
  registry: ModelRegistry,
  routing: RoutingStrategy,
  credentialStore: SqliteCredentialStore,
  providerRegistry: ProviderRegistry,
  usageStore: UsageStore
) {
  return async (c: Context) => {
    let body: ResponsesRequest
    try {
      body = await c.req.json<ResponsesRequest>()
    } catch {
      return c.json({ error: { message: 'Invalid JSON', type: 'invalid_request_error', code: '400' } }, 400)
    }

    // Check for unsupported tool types
    const unsupported = findUnsupportedType(body.input ?? [])
    if (unsupported) {
      return c.json(
        {
          error: {
            message: `Event type '${unsupported}' is not yet supported by keyrouter`,
            type: 'not_implemented',
            code: '501',
          },
        },
        501
      )
    }

    // ── Convert to Chat Completions format ────────────────────────────────
    const modelId = body.model
    const modelEntry = registry.lookup(modelId)
    if (!modelEntry) {
      return c.json({ error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error', code: '404' } }, 404)
    }

    const messages = inputToMessages(body.input ?? [], body.instructions)

    // Build canonical chat request — spread to preserve any unknown fields
    const chatBody = {
      ...body,
      model: modelEntry.upstreamId,
      messages,
      stream: false,  // Responses API non-streaming for now
    }
    // Remove Responses-specific fields that Chat API doesn't understand
    delete (chatBody as Record<string, unknown>)['input']
    delete (chatBody as Record<string, unknown>)['instructions']

    const accounts = routing.selectAccounts(modelId, modelEntry.accounts)
    if (accounts.length === 0) {
      return c.json({ error: { message: 'All accounts unavailable', type: 'service_unavailable', code: '503' } }, 503)
    }

    const startTime = Date.now()
    let lastError: Error | null = null

    for (const account of accounts) {
      const provider = providerRegistry.get(account.providerId)
      if (!provider) continue

      let cred
      try {
        cred = await credentialStore.resolve(account.providerId, account.id)
      } catch (err) {
        if (err instanceof CredentialNotFoundError || err instanceof OAuthRevokedError) {
          return c.json({ error: { message: (err as Error).message, type: 'service_unavailable', code: '503' } }, 503)
        }
        lastError = err as Error
        continue
      }

      const upstreamUrl = `${provider.baseUrl}/v1/chat/completions`
      const headers = provider.requestHeaders(cred)

      let response: Response
      try {
        response = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(chatBody),
          signal: c.req.raw.signal,
        })
      } catch (err) {
        if ((err as Error).name === 'AbortError') return new Response(null, { status: 499 })
        routing.onError(account.id, modelId, 0)
        lastError = err as Error
        continue
      }

      if (response.status === 429 || response.status >= 500) {
        routing.onError(account.id, modelId, response.status)
        lastError = new Error(`Provider returned ${response.status}`)
        continue
      }

      if (!response.ok) {
        lastError = new Error(`Upstream ${response.status}`)
        continue
      }

      const chatJson = await response.json() as Record<string, unknown>
      routing.onSuccess(account.id, modelId)

      const usage = chatJson['usage'] as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
      usageStore.record({
        modelId,
        providerId: account.providerId,
        accountId: account.id,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
        durationMs: Date.now() - startTime,
        streamingRequest: false,
        timestamp: Date.now(),
      }).catch((err: Error) => console.warn('[keyrouter] usage record failed:', err))

      // Convert back to Responses API format
      const responsesJson = wrapChatResponse(chatJson)
      return c.json(responsesJson)
    }

    return c.json(
      { error: { message: `All providers failed: ${lastError?.message ?? 'unknown'}`, type: 'service_unavailable', code: '503' } },
      503
    )
  }
}
