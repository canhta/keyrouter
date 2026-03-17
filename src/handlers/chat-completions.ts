// src/handlers/chat-completions.ts — POST /v1/chat/completions
//
// Request flow and retry loop:
//
//   ┌─ parse + validate body ──────────────────────────────────────────────┐
//   │  size limit (1MB) → 413                                             │
//   │  invalid JSON → 400                                                 │
//   └──────────────────────────────────────────────────────────────────────┘
//       │
//   ┌─ model lookup ────────────────────────────────────────────────────────┐
//   │  ModelRegistry.lookup(model) → null → 404 OpenAI format             │
//   └──────────────────────────────────────────────────────────────────────┘
//       │
//   ┌─ account selection ───────────────────────────────────────────────────┐
//   │  RoutingStrategy.selectAccounts() → [] → 503 + Retry-After          │
//   └──────────────────────────────────────────────────────────────────────┘
//       │
//   ┌─ retry loop (for each account) ──────────────────────────────────────┐
//   │  CredentialStore.resolve() → CredentialNotFoundError → 503          │
//   │  ProviderDefinition.requestHeaders(cred) → build headers            │
//   │  fetch(url, { signal, headers, body })                              │
//   │    timeout/5xx → onError() + continue                               │
//   │    429         → onError() + continue                               │
//   │    401         → refresh → retry once → if 401 again: 503           │
//   │    HTML body   → JSON.parse catch → onError() + continue            │
//   │    success     → break retry loop                                   │
//   └──────────────────────────────────────────────────────────────────────┘
//       │
//   ┌─ stream vs non-stream ────────────────────────────────────────────────┐
//   │  stream:true  → pipe through UsageSynthesisTransform                │
//   │  stream:false → buffer + return JSON                                │
//   └──────────────────────────────────────────────────────────────────────┘

import type { Context } from 'hono'
import type { ModelRegistry } from '../registry/index.ts'
import type { RoutingStrategy, CanonicalChatRequest } from '../types.ts'
import { CredentialNotFoundError, OAuthRevokedError } from '../types.ts'
import type { SqliteCredentialStore } from '../auth/store.ts'
import type { ProviderRegistry } from '../providers/index.ts'
import type { UsageStore } from '../usage/store.ts'
import { createUsageSynthesisStream } from '../translation/stream.ts'

const MAX_BODY_SIZE = 1024 * 1024  // 1 MB

export function createChatCompletionsHandler(
  registry: ModelRegistry,
  routing: RoutingStrategy,
  credentialStore: SqliteCredentialStore,
  providerRegistry: ProviderRegistry,
  usageStore: UsageStore
) {
  return async (c: Context) => {
    // ── Body parsing ─────────────────────────────────────────────────────
    const contentLength = parseInt(c.req.header('content-length') ?? '0', 10)
    if (contentLength > MAX_BODY_SIZE) {
      return c.json(openAIError('Request body too large', 413, 'request_too_large'), 413)
    }

    let body: CanonicalChatRequest
    try {
      body = await c.req.json<CanonicalChatRequest>()
    } catch {
      return c.json(openAIError('Invalid JSON in request body', 400, 'invalid_request_error'), 400)
    }

    const modelId = body.model
    if (!modelId) {
      return c.json(openAIError('model is required', 400, 'invalid_request_error'), 400)
    }

    // ── Model lookup ─────────────────────────────────────────────────────
    const modelEntry = registry.lookup(modelId)
    if (!modelEntry) {
      return c.json(
        openAIError(`The model '${modelId}' does not exist`, 404, 'invalid_request_error'),
        404
      )
    }

    // ── Account selection ─────────────────────────────────────────────────
    const accounts = routing.selectAccounts(modelId, modelEntry.accounts)
    if (accounts.length === 0) {
      return c.json(
        openAIError('All accounts are temporarily unavailable', 503, 'service_unavailable'),
        503,
        { 'Retry-After': '30' }
      )
    }

    // ── Retry loop ────────────────────────────────────────────────────────
    const startTime = Date.now()
    let lastError: Error | null = null

    for (const account of accounts) {
      const provider = providerRegistry.get(account.providerId)
      if (!provider) {
        console.warn(`[keyrouter] unknown provider: ${account.providerId}`)
        continue
      }

      // Resolve credential
      let cred
      try {
        cred = await credentialStore.resolve(account.providerId, account.id)
      } catch (err) {
        if (err instanceof CredentialNotFoundError) {
          return c.json(
            openAIError(err.message, 503, 'service_unavailable'),
            503
          )
        }
        if (err instanceof OAuthRevokedError) {
          return c.json(
            openAIError(err.message, 503, 'service_unavailable'),
            503
          )
        }
        lastError = err as Error
        continue
      }

      // Build upstream request
      // CRITICAL: use spread, never destructure body (preserves reasoning_opaque + unknown fields)
      const upstreamBody = { ...body, model: modelEntry.upstreamId }
      const upstreamUrl = `${provider.baseUrl}/v1/chat/completions`
      const headers = provider.requestHeaders(cred)

      // Make upstream request — propagate AbortController signal for client disconnect
      let response: Response
      try {
        response = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(upstreamBody),
          signal: c.req.raw.signal,
        })
      } catch (err) {
        // Network error / timeout / client disconnect
        if ((err as Error).name === 'AbortError') {
          // Client disconnected — don't retry
          return new Response(null, { status: 499 })
        }
        console.warn(`[keyrouter] fetch error for ${account.id}:`, err)
        routing.onError(account.id, modelId, 0)
        lastError = err as Error
        continue
      }

      // ── Error classification ─────────────────────────────────────────
      if (response.status === 429 || response.status >= 500) {
        console.warn(`[keyrouter] ${response.status} from ${account.id}, locking`)
        routing.onError(account.id, modelId, response.status)
        lastError = new Error(`Provider returned ${response.status}`)
        continue
      }

      if (response.status === 401) {
        // Attempt token refresh once
        try {
          const refreshed = await credentialStore.resolve(account.providerId, account.id)
          const retryHeaders = provider.requestHeaders(refreshed)
          const retryResponse = await fetch(upstreamUrl, {
            method: 'POST',
            headers: retryHeaders,
            body: JSON.stringify(upstreamBody),
            signal: c.req.raw.signal,
          })
          if (retryResponse.status === 401) {
            routing.onError(account.id, modelId, 401)
            lastError = new Error('Token refresh failed')
            continue
          }
          // Use retried response
          return await buildResponse(c, retryResponse, {
            account, modelId, providerId: account.providerId, startTime,
            routing, usageStore, body
          })
        } catch (err) {
          if (err instanceof OAuthRevokedError) {
            return c.json(
              openAIError(err.message, 503, 'service_unavailable'),
              503
            )
          }
          routing.onError(account.id, modelId, 401)
          lastError = err as Error
          continue
        }
      }

      // Check for HTML error response (provider unavailable / misconfigured)
      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok || contentType.includes('text/html')) {
        const text = await response.text()
        if (contentType.includes('text/html')) {
          console.warn(`[keyrouter] HTML response from ${account.id}: ${text.slice(0, 200)}`)
          routing.onError(account.id, modelId, response.status)
          lastError = new Error('Provider returned HTML (unexpected response)')
          continue
        }
      }

      // ── Success ─────────────────────────────────────────────────────────
      return await buildResponse(c, response, {
        account, modelId, providerId: account.providerId, startTime,
        routing, usageStore, body
      })
    }

    // All accounts failed
    return c.json(
      openAIError(
        `All providers failed. Last error: ${lastError?.message ?? 'unknown'}`,
        503,
        'service_unavailable'
      ),
      503,
      { 'Retry-After': '30' }
    )
  }
}

interface BuildResponseOpts {
  account: { id: string; providerId: string }
  modelId: string
  providerId: string
  startTime: number
  routing: RoutingStrategy
  usageStore: UsageStore
  body: CanonicalChatRequest
}

async function buildResponse(
  c: Context,
  response: Response,
  opts: BuildResponseOpts
): Promise<Response> {
  const { account, modelId, providerId, startTime, routing, usageStore, body } = opts
  const isStreaming = body.stream === true

  if (!isStreaming) {
    // Non-streaming: buffer response + record usage
    const json = await response.json() as Record<string, unknown> & { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
    routing.onSuccess(account.id, modelId)

    const usage = json.usage
    usageStore.record({
      modelId,
      providerId,
      accountId: account.id,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      durationMs: Date.now() - startTime,
      streamingRequest: false,
      timestamp: Date.now(),
    }).catch((err: Error) => console.warn('[keyrouter] usage record failed:', err))

    return c.json(json)
  }

  // Streaming: pipe through UsageSynthesisTransform
  if (!response.body) {
    return c.json(openAIError('Empty response body from provider', 503, 'service_unavailable'), 503)
  }

  const synthesisStream = createUsageSynthesisStream({
    modelId,
    accountId: account.id,
    providerId,
    startTime,
    onComplete: (record) => {
      routing.onSuccess(account.id, modelId)
      usageStore
        .record({ ...record, timestamp: Date.now() })
        .catch((err: Error) => console.warn('[keyrouter] usage record failed:', err))
    },
  })

  const transformed = response.body.pipeThrough(synthesisStream)

  return new Response(transformed, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

function openAIError(message: string, status: number, type: string) {
  return {
    error: {
      message,
      type,
      code: String(status),
    },
  }
}
