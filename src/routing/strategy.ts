// src/routing/strategy.ts — RoutingStrategy implementation
//
// selectAccounts() ordering logic:
//
//   accounts[]
//       │
//       ├─ read lockedUntil for each from LockStore
//       │
//       ├─ split: unlocked (lockedUntil < now) vs locked (lockedUntil >= now)
//       │
//       ├─ unlocked: sort by round-robin offset (lastUsed tracking via Map)
//       │
//       ├─ locked: sort by lockedUntil ASC (retry soonest-available first)
//       │
//       └─ return [...unlocked, ...locked]
//
// Returns [] if all accounts are locked.

import type { AccountEntry, RoutingStrategy } from '../types.ts'
import type { LockStore } from './lock-store.ts'

export class DefaultRoutingStrategy implements RoutingStrategy {
  // Round-robin counter per modelId
  private roundRobinCounter = new Map<string, number>()

  constructor(private lockStore: LockStore) {}

  selectAccounts(modelId: string, accounts: AccountEntry[]): AccountEntry[] {
    if (accounts.length === 0) return []

    const now = Date.now()
    const locks = this.lockStore.getLocks(
      accounts.map(a => a.id),
      modelId
    )

    const unlocked: AccountEntry[] = []
    const locked: Array<{ account: AccountEntry; lockedUntil: number }> = []

    for (const account of accounts) {
      const lockedUntil = locks.get(account.id) ?? 0
      if (lockedUntil < now) {
        unlocked.push(account)
      } else {
        locked.push({ account, lockedUntil })
      }
    }

    // Round-robin unlocked accounts
    if (unlocked.length > 1) {
      const counter = this.roundRobinCounter.get(modelId) ?? 0
      const rotated = [
        ...unlocked.slice(counter % unlocked.length),
        ...unlocked.slice(0, counter % unlocked.length),
      ]
      return [
        ...rotated,
        ...locked.sort((a, b) => a.lockedUntil - b.lockedUntil).map(l => l.account),
      ]
    }

    return [
      ...unlocked,
      ...locked.sort((a, b) => a.lockedUntil - b.lockedUntil).map(l => l.account),
    ]
  }

  onSuccess(accountId: string, modelId: string): void {
    this.lockStore.onSuccess(accountId, modelId)
    // Advance round-robin counter
    const counter = this.roundRobinCounter.get(modelId) ?? 0
    this.roundRobinCounter.set(modelId, counter + 1)
  }

  onError(accountId: string, modelId: string, statusCode: number): void {
    this.lockStore.onError(accountId, modelId, statusCode)
  }
}
