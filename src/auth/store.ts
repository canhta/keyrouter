// src/auth/store.ts — SQLite-backed CredentialStore with in-flight dedup
//
// resolve() state machine:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  resolve(providerId, accountId)                                 │
//   │                                                                 │
//   │  ┌─ read from SQLite ─────────────────────────────────────────┐ │
//   │  │  found?  No → throw CredentialNotFoundError                │ │
//   │  │          Yes ↓                                             │ │
//   │  └────────────────────────────────────────────────────────────┘ │
//   │                                                                 │
//   │  ┌─ check expiry ──────────────────────────────────────────────┐ │
//   │  │  expiresAt undefined → return as-is (API key)              │ │
//   │  │  expiresAt > now+5min → return as-is (fresh)               │ │
//   │  │  expiresAt <= now+5min → needs refresh ↓                   │ │
//   │  └────────────────────────────────────────────────────────────┘ │
//   │                                                                 │
//   │  ┌─ refresh with in-flight dedup ─────────────────────────────┐ │
//   │  │  key = `${providerId}/${accountId}`                        │ │
//   │  │  refreshing.has(key)?                                      │ │
//   │  │    Yes → return existing Promise (concurrent dedup)        │ │
//   │  │    No  → create Promise, store in map, remove on complete  │ │
//   │  │  refresh() → 200 → save → return new Credential           │ │
//   │  │  refresh() → 401 → OAuthRevokedError → clear + re-throw   │ │
//   │  └────────────────────────────────────────────────────────────┘ │
//   └─────────────────────────────────────────────────────────────────┘

import type { Database } from 'bun:sqlite'
import { type Credential, type CredentialStore, type OAuthProvider, CredentialNotFoundError, OAuthRevokedError } from '../types.ts'

const REFRESH_BUFFER_MS = 5 * 60 * 1000  // refresh 5 min before expiry

interface DbCredential {
  provider_id: string
  account_id: string
  type: 'api_key' | 'oauth'
  value: string
  refresh_token: string | null
  expires_at: number | null
}

export class SqliteCredentialStore implements CredentialStore {
  /** In-flight refresh promises keyed by "providerId/accountId". */
  private refreshing = new Map<string, Promise<Credential>>()

  constructor(
    private db: Database,
    /** Provider-specific OAuth implementations for token refresh. */
    private oauthProviders: Map<string, OAuthProvider> = new Map()
  ) {}

  async resolve(providerId: string, accountId: string): Promise<Credential> {
    const row = this.db
      .query<DbCredential, [string, string]>(
        'SELECT * FROM credentials WHERE provider_id = ? AND account_id = ?'
      )
      .get(providerId, accountId)

    if (!row) {
      throw new CredentialNotFoundError(providerId, accountId)
    }

    const cred = dbRowToCredential(row)

    // API keys never expire
    if (cred.type === 'api_key' || cred.expiresAt === undefined) {
      return cred
    }

    // Fresh enough (more than 5 min remaining)
    if (cred.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
      return cred
    }

    // Needs refresh — deduplicate concurrent calls
    return this.refreshWithDedup(providerId, accountId, cred)
  }

  async save(cred: Credential): Promise<void> {
    this.db
      .query(
        `INSERT INTO credentials (provider_id, account_id, type, value, refresh_token, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, account_id) DO UPDATE SET
           type = excluded.type,
           value = excluded.value,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .run(
        cred.providerId,
        cred.accountId,
        cred.type,
        cred.value,
        cred.refreshToken ?? null,
        cred.expiresAt ?? null,
        Date.now()
      )
  }

  async clear(providerId: string, accountId: string): Promise<void> {
    this.db
      .query('DELETE FROM credentials WHERE provider_id = ? AND account_id = ?')
      .run(providerId, accountId)
  }

  private async refreshWithDedup(
    providerId: string,
    accountId: string,
    cred: Credential
  ): Promise<Credential> {
    const key = `${providerId}/${accountId}`

    const existing = this.refreshing.get(key)
    if (existing) return existing

    const promise = this.doRefresh(providerId, accountId, cred).finally(() => {
      this.refreshing.delete(key)
    })

    this.refreshing.set(key, promise)
    return promise
  }

  private async doRefresh(
    providerId: string,
    accountId: string,
    cred: Credential
  ): Promise<Credential> {
    const oauthProvider = this.oauthProviders.get(providerId)
    if (!oauthProvider) {
      throw new CredentialNotFoundError(providerId, accountId)
    }

    try {
      const refreshed = await oauthProvider.refreshToken(cred)
      await this.save(refreshed)
      return refreshed
    } catch (err) {
      if (err instanceof OAuthRevokedError) {
        await this.clear(providerId, accountId)
        throw err
      }
      throw err
    }
  }

  registerOAuthProvider(providerId: string, provider: OAuthProvider): void {
    this.oauthProviders.set(providerId, provider)
  }
}

function dbRowToCredential(row: DbCredential): Credential {
  return {
    providerId: row.provider_id,
    accountId: row.account_id,
    type: row.type,
    value: row.value,
    refreshToken: row.refresh_token ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  }
}
