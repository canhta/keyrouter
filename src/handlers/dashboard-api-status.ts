// src/handlers/dashboard-api-status.ts — GET /dashboard/api/status, GET /dashboard/api/usage

import type { Context } from 'hono'
import type { ModelRegistry } from '../registry/index.ts'
import type { LockStore } from '../routing/lock-store.ts'
import type { SqliteCredentialStore } from '../auth/store.ts'
import type { UsageStore } from '../usage/store.ts'
import type { Database } from 'bun:sqlite'
import { buildAccountStatusMap } from '../routing/account-status.ts'

export function createDashboardStatusHandler(
  registry: ModelRegistry,
  lockStore: LockStore,
  credentialStore: SqliteCredentialStore
) {
  return (c: Context) => {
    const models = registry.list()
    const accounts = buildAccountStatusMap(registry, lockStore, credentialStore)

    return c.json({
      models: models.map(m => ({
        id: m.id,
        upstreamId: m.upstreamId,
        accounts: m.accounts,
      })),
      accounts,
    })
  }
}

export function createDashboardUsageHandler(db: Database) {
  return (c: Context) => {
    const since = Date.now() - 24 * 60 * 60 * 1000  // 24h

    const rows = db
      .query<{ model_id: string; total_requests: number; total_tokens: number }, [number]>(
        `SELECT model_id,
                COUNT(*) as total_requests,
                SUM(total_tokens) as total_tokens
         FROM usage
         WHERE timestamp > ?
         GROUP BY model_id
         ORDER BY total_requests DESC`
      )
      .all(since)

    const providerLimits = db
      .query<{
        provider_id: string; account_id: string
        limit_req: number | null; remaining_req: number | null
        limit_tok: number | null; remaining_tok: number | null
        reset_req_at: number | null; reset_tok_at: number | null
        captured_at: number
      }, []>('SELECT * FROM provider_limits')
      .all()

    return c.json({
      period: '24h',
      byModel: rows.map(r => ({
        modelId: r.model_id,
        requests: r.total_requests,
        tokens: r.total_tokens,
      })),
      providerLimits: providerLimits.map(r => ({
        providerId: r.provider_id,
        accountId: r.account_id,
        limitRequests: r.limit_req,
        remainingRequests: r.remaining_req,
        limitTokens: r.limit_tok,
        remainingTokens: r.remaining_tok,
        resetRequestsAt: r.reset_req_at,
        resetTokensAt: r.reset_tok_at,
        capturedAt: r.captured_at,
      })),
    })
  }
}
