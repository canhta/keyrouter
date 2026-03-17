// src/routing/account-status.ts — shared account status aggregation
//
// Used by:
//   GET /v1/status        (handlers/status.ts)
//   GET /dashboard/api/status  (handlers/dashboard-api-status.ts)
//
// Reads lock state + credential expiry without triggering token refresh.

import type { ModelRegistry } from '../registry/index.ts'
import type { LockStore } from './lock-store.ts'
import type { SqliteCredentialStore } from '../auth/store.ts'

export interface AccountStatus {
  providerId: string
  locked: boolean
  lockedUntilMs?: number
  hasCredential: boolean
  tokenExpiresAt?: number  // unix ms; undefined = API key or no credential
}

export function buildAccountStatusMap(
  registry: ModelRegistry,
  lockStore: LockStore,
  credentialStore: SqliteCredentialStore
): Record<string, AccountStatus> {
  const now = Date.now()
  const models = registry.list()
  const result: Record<string, AccountStatus> = {}

  for (const model of models) {
    for (const account of model.accounts) {
      if (result[account.id]) continue

      const lockedUntil = lockStore.getLockedUntil(account.id, model.id)
      const locked = lockedUntil > now
      const peek = credentialStore.peek(account.providerId, account.id)

      result[account.id] = {
        providerId: account.providerId,
        locked,
        lockedUntilMs: locked ? lockedUntil : undefined,
        hasCredential: peek.hasCredential,
        tokenExpiresAt: peek.expiresAt,
      }
    }
  }

  return result
}
