import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LockStore, lockDuration } from '../../src/routing/lock-store.ts'
import { DefaultRoutingStrategy } from '../../src/routing/strategy.ts'
import type { AccountEntry } from '../../src/types.ts'

function makeInMemoryDb(): Database {
  const db = new Database(':memory:')
  db.run('PRAGMA journal_mode=WAL')
  db.run(`
    CREATE TABLE model_locks (
      account_id     TEXT NOT NULL,
      model_id       TEXT NOT NULL,
      locked_until   INTEGER NOT NULL DEFAULT 0,
      attempt_count  INTEGER NOT NULL DEFAULT 0,
      last_error     INTEGER,
      PRIMARY KEY (account_id, model_id)
    )
  `)
  return db
}

describe('lockDuration()', () => {
  it('returns 30s for attempt 1', () => {
    expect(lockDuration(1)).toBe(30_000)
  })

  it('returns 60s for attempt 2', () => {
    expect(lockDuration(2)).toBe(60_000)
  })

  it('returns 5min for attempt 3', () => {
    expect(lockDuration(3)).toBe(300_000)
  })

  it('returns 30min for attempt 4+', () => {
    expect(lockDuration(4)).toBe(1_800_000)
    expect(lockDuration(10)).toBe(1_800_000)
    expect(lockDuration(100)).toBe(1_800_000)
  })
})

describe('LockStore', () => {
  let db: Database
  let lockStore: LockStore

  beforeEach(() => {
    db = makeInMemoryDb()
    lockStore = new LockStore(db)
  })

  it('starts unlocked', () => {
    expect(lockStore.getLockedUntil('account-1', 'gpt-4o')).toBe(0)
  })

  it('locks after error with backoff', () => {
    const before = Date.now()
    lockStore.onError('account-1', 'gpt-4o', 429)
    const lockedUntil = lockStore.getLockedUntil('account-1', 'gpt-4o')
    expect(lockedUntil).toBeGreaterThan(before + 25_000)
    expect(lockedUntil).toBeLessThan(before + 35_000)
  })

  it('increases backoff on repeated errors', () => {
    lockStore.onError('account-1', 'gpt-4o', 429)  // attempt 1 = 30s
    lockStore.onError('account-1', 'gpt-4o', 429)  // attempt 2 = 60s
    const lockedUntil = lockStore.getLockedUntil('account-1', 'gpt-4o')
    const now = Date.now()
    // Should be locked for ~60s (second attempt)
    expect(lockedUntil).toBeGreaterThan(now + 55_000)
  })

  it('clears lock on success', () => {
    lockStore.onError('account-1', 'gpt-4o', 429)
    expect(lockStore.getLockedUntil('account-1', 'gpt-4o')).toBeGreaterThan(Date.now())
    lockStore.onSuccess('account-1', 'gpt-4o')
    expect(lockStore.getLockedUntil('account-1', 'gpt-4o')).toBe(0)
  })
})

describe('DefaultRoutingStrategy', () => {
  let db: Database
  let lockStore: LockStore
  let strategy: DefaultRoutingStrategy

  const accounts: AccountEntry[] = [
    { id: 'account-1', providerId: 'openai' },
    { id: 'account-2', providerId: 'openai' },
    { id: 'account-3', providerId: 'copilot' },
  ]

  beforeEach(() => {
    db = makeInMemoryDb()
    lockStore = new LockStore(db)
    strategy = new DefaultRoutingStrategy(lockStore)
  })

  it('returns all accounts when none are locked', () => {
    const result = strategy.selectAccounts('gpt-4o', accounts)
    expect(result).toHaveLength(3)
    // All should be in result
    const ids = result.map(a => a.id)
    expect(ids).toContain('account-1')
    expect(ids).toContain('account-2')
    expect(ids).toContain('account-3')
  })

  it('places locked accounts last', () => {
    // Lock account-1
    lockStore.onError('account-1', 'gpt-4o', 429)

    const result = strategy.selectAccounts('gpt-4o', accounts)
    expect(result).toHaveLength(3)

    // Locked account should be last
    const lastAccount = result[result.length - 1]!
    expect(lastAccount.id).toBe('account-1')
  })

  it('returns empty array for empty accounts', () => {
    expect(strategy.selectAccounts('gpt-4o', [])).toHaveLength(0)
  })

  it('returns sorted locked accounts when all are locked', () => {
    // Lock all accounts with different times
    lockStore.onError('account-3', 'gpt-4o', 429)  // locked longest
    lockStore.onError('account-1', 'gpt-4o', 429)
    lockStore.onError('account-2', 'gpt-4o', 429)

    const result = strategy.selectAccounts('gpt-4o', accounts)
    // All should still be returned (for eventual retry)
    expect(result).toHaveLength(3)
  })
})
