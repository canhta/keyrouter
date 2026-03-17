// src/handlers/status.ts — GET /v1/status

import type { Context } from 'hono'
import type { ModelRegistry } from '../registry/index.ts'
import type { LockStore } from '../routing/lock-store.ts'
import type { SqliteCredentialStore } from '../auth/store.ts'
import { buildAccountStatusMap } from '../routing/account-status.ts'

export function createStatusHandler(
  registry: ModelRegistry,
  lockStore: LockStore,
  credentialStore: SqliteCredentialStore
) {
  return (c: Context) => {
    const models = registry.list()
    const accounts = buildAccountStatusMap(registry, lockStore, credentialStore)

    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      models: models.map(m => ({ id: m.id, accounts: m.accounts.length })),
      accounts,
    })
  }
}
