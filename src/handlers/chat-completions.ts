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
import type { DashboardEventBus } from '../events/bus.ts'
import type { Database } from 'bun:sqlite'
import { createUsageSynthesisStream } from '../translation/stream.ts'

const MAX_BODY_SIZE = 1024 * 1024  // 1 MB

export function createChatCompletionsHandler(
  registry: ModelRegistry,
  routing: RoutingStrategy,
  credentialStore: SqliteCredentialStore,
  providerRegistry: ProviderRegistry,
  usageStore: UsageStore,
  bus?: DashboardEventBus,
  db?: Database
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
      // Also add a 60s timeout so hung connections don't block forever
      let response: Response
      try {
        const timeoutSignal = AbortSignal.timeout(60_000)
        const signal = AbortSignal.any
          ? AbortSignal.any([c.req.raw.signal, timeoutSignal])
          : c.req.raw.signal
        response = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(upstreamBody),
          signal,
        })
      } catch (err) {
        // Network error / timeout / client disconnect
        if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
          const isTimeout = (err as Error).name === 'TimeoutError'
          if (!isTimeout) {
            // Client disconnected — don't retry
            return new Response(null, { status: 499 })
          }
          // Timeout — lock account + try next
          console.warn(`[keyrouter] timeout for ${account.id}, locking`)
          routing.onError(account.id, modelId, 0)
          lastError = err as Error
          continue
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
          captureProviderLimits(retryResponse, account.providerId, account.id, db)
          return await buildResponse(c, retryResponse, {
            account, modelId, providerId: account.providerId, startTime,
            routing, usageStore, body, bus, db
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

      // Capture rate-limit headers before consuming body (headers available immediately)
      captureProviderLimits(response, account.providerId, account.id, db)

      // ── Success ─────────────────────────────────────────────────────────
      return await buildResponse(c, response, {
        account, modelId, providerId: account.providerId, startTime,
        routing, usageStore, body, bus, db
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
  bus?: DashboardEventBus
  db?: Database
}

async function buildResponse(
  c: Context,
  response: Response,
  opts: BuildResponseOpts
): Promise<Response> {
  const { account, modelId, providerId, startTime, routing, usageStore, body, bus } = opts
  const isStreaming = body.stream === true

  if (!isStreaming) {
    // Non-streaming: buffer response + record usage
    const json = await response.json() as Record<string, unknown> & { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
    routing.onSuccess(account.id, modelId)

    const usage = json.usage
    const totalTokens = usage?.total_tokens ?? 0
    usageStore.record({
      modelId,
      providerId,
      accountId: account.id,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens,
      durationMs: Date.now() - startTime,
      streamingRequest: false,
      timestamp: Date.now(),
    }).catch((err: Error) => console.warn('[keyrouter] usage record failed:', err))

    bus?.publish({ type: 'request', data: { model: modelId, provider: providerId, account: account.id, status: 200, latencyMs: Date.now() - startTime, tokens: totalTokens } })

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
      bus?.publish({ type: 'request', data: { model: modelId, provider: providerId, account: account.id, status: 200, latencyMs: Date.now() - startTime, tokens: record.totalTokens ?? 0 } })
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

/** Capture x-ratelimit-* headers from upstream response and upsert into provider_limits. Fire-and-forget. */
function captureProviderLimits(response: Response, providerId: string, accountId: string, db?: Database): void {
  if (!db) return
  const h = response.headers

  const limitReq     = parseHeaderInt(h.get('x-ratelimit-limit-requests'))
  const remainingReq = parseHeaderInt(h.get('x-ratelimit-remaining-requests'))
  const limitTok     = parseHeaderInt(h.get('x-ratelimit-limit-tokens'))
  const remainingTok = parseHeaderInt(h.get('x-ratelimit-remaining-tokens'))
  const resetReqAt   = parseResetMs(h.get('x-ratelimit-reset-requests'))
  const resetTokAt   = parseResetMs(h.get('x-ratelimit-reset-tokens'))

  // Skip if no rate-limit headers present at all
  if (limitReq === null && remainingReq === null && limitTok === null && remainingTok === null) return

  try {
    db.query(
      `INSERT INTO provider_limits (provider_id, account_id, limit_req, remaining_req, limit_tok, remaining_tok, reset_req_at, reset_tok_at, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, account_id) DO UPDATE SET
         limit_req = excluded.limit_req,
         remaining_req = excluded.remaining_req,
         limit_tok = excluded.limit_tok,
         remaining_tok = excluded.remaining_tok,
         reset_req_at = excluded.reset_req_at,
         reset_tok_at = excluded.reset_tok_at,
         captured_at = excluded.captured_at`
    ).run(providerId, accountId, limitReq, remainingReq, limitTok, remainingTok, resetReqAt, resetTokAt, Date.now())
  } catch (err) {
    console.warn('[keyrouter] provider_limits write failed:', err)
  }
}

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null
  const n = parseInt(value, 10)
  return isNaN(n) ? null : n
}

/** Parse reset header like "1s", "500ms", or ISO timestamp → unix ms */
function parseResetMs(value: string | null): number | null {
  if (!value) return null
  // ISO timestamp
  if (value.includes('T') || value.includes('-')) {
    const t = Date.parse(value)
    return isNaN(t) ? null : t
  }
  // Duration like "1s", "500ms", "1m30s"
  const now = Date.now()
  let ms = 0
  const parts = value.matchAll(/(\d+)(ms|s|m|h)/g)
  for (const [, n, unit] of parts) {
    const v = parseInt(n ?? '0', 10)
    if (unit === 'ms') ms += v
    else if (unit === 's') ms += v * 1000
    else if (unit === 'm') ms += v * 60_000
    else if (unit === 'h') ms += v * 3_600_000
  }
  return ms > 0 ? now + ms : null
}
