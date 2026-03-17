// src/usage/store.ts — UsageStore: fire-and-forget async writes to SQLite

import type { Database } from 'bun:sqlite'
import type { UsageRecord } from '../types.ts'

export class UsageStore {
  constructor(private db: Database) {}

  /** Record a usage event. Never throws — errors are logged as warnings. */
  async record(record: Partial<UsageRecord>): Promise<void> {
    try {
      this.db
        .query(
          `INSERT INTO usage (timestamp, model_id, provider_id, account_id,
            prompt_tokens, completion_tokens, total_tokens, duration_ms, streaming)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.timestamp ?? Date.now(),
          record.modelId ?? '',
          record.providerId ?? '',
          record.accountId ?? '',
          record.promptTokens ?? 0,
          record.completionTokens ?? 0,
          record.totalTokens ?? 0,
          record.durationMs ?? 0,
          record.streamingRequest ? 1 : 0
        )
    } catch (err) {
      console.warn('[keyrouter] usage write failed:', err)
    }
  }

  /** Fetch recent usage records for the status endpoint. */
  recent(limit = 50): UsageRecord[] {
    return this.db
      .query<
        {
          id: number; timestamp: number; model_id: string; provider_id: string
          account_id: string; prompt_tokens: number; completion_tokens: number
          total_tokens: number; duration_ms: number; streaming: number
        },
        [number]
      >(
        `SELECT * FROM usage ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit)
      .map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        modelId: row.model_id,
        providerId: row.provider_id,
        accountId: row.account_id,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
        durationMs: row.duration_ms,
        streamingRequest: row.streaming === 1,
      }))
  }
}
