// src/routing/lock-store.ts — SQLite-backed lock backoff
//
// Backoff sequence: attempt 1=30s, 2=60s, 3=300s, 4+=1800s
//
//   attempt   lock duration
//   ───────   ────────────
//     1       30s
//     2       60s
//     3       5m
//     4+      30m

import type { Database } from 'bun:sqlite'

const BACKOFF_MS = [30_000, 60_000, 300_000, 1_800_000]

export function lockDuration(attemptCount: number): number {
  return BACKOFF_MS[Math.min(attemptCount - 1, BACKOFF_MS.length - 1)]!
}

export class LockStore {
  constructor(private db: Database) {}

  /** Record an error for (accountId, modelId); increment attempt count + set expiry. */
  onError(accountId: string, modelId: string, statusCode: number): void {
    const now = Date.now()

    // Get current attempt count
    const row = this.db
      .query<{ attempt_count: number }, [string, string]>(
        'SELECT attempt_count FROM model_locks WHERE account_id = ? AND model_id = ?'
      )
      .get(accountId, modelId)

    const newAttempt = ((row?.attempt_count) ?? 0) + 1
    const duration = lockDuration(newAttempt)
    const lockedUntil = now + duration

    this.db
      .query(
        `INSERT INTO model_locks (account_id, model_id, locked_until, attempt_count, last_error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, model_id) DO UPDATE SET
           locked_until = excluded.locked_until,
           attempt_count = excluded.attempt_count,
           last_error = excluded.last_error`
      )
      .run(accountId, modelId, lockedUntil, newAttempt, statusCode)
  }

  /** Clear lock on success; reset attempt count. */
  onSuccess(accountId: string, modelId: string): void {
    this.db
      .query(
        `INSERT INTO model_locks (account_id, model_id, locked_until, attempt_count)
         VALUES (?, ?, 0, 0)
         ON CONFLICT(account_id, model_id) DO UPDATE SET
           locked_until = 0,
           attempt_count = 0`
      )
      .run(accountId, modelId)
  }

  /** Returns timestamp (ms) until which this account is locked. 0 = not locked. */
  getLockedUntil(accountId: string, modelId: string): number {
    const row = this.db
      .query<{ locked_until: number }, [string, string]>(
        'SELECT locked_until FROM model_locks WHERE account_id = ? AND model_id = ?'
      )
      .get(accountId, modelId)
    return row?.locked_until ?? 0
  }

  /** Get all lock records for multiple accounts at once. */
  getLocks(accountIds: string[], modelId: string): Map<string, number> {
    if (accountIds.length === 0) return new Map()
    const placeholders = accountIds.map(() => '?').join(',')
    const rows = this.db
      .query<{ account_id: string; locked_until: number }, string[]>(
        `SELECT account_id, locked_until FROM model_locks
         WHERE account_id IN (${placeholders}) AND model_id = ?`
      )
      .all(...accountIds, modelId)

    const result = new Map<string, number>()
    for (const row of rows) {
      result.set(row.account_id, row.locked_until)
    }
    return result
  }
}
