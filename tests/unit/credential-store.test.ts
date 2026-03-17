import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteCredentialStore } from '../../src/auth/store.ts'
import { CredentialNotFoundError, OAuthRevokedError, type Credential, type OAuthProvider } from '../../src/types.ts'

function makeInMemoryDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE credentials (
      provider_id    TEXT NOT NULL,
      account_id     TEXT NOT NULL,
      type           TEXT NOT NULL,
      value          TEXT NOT NULL,
      refresh_token  TEXT,
      expires_at     INTEGER,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      PRIMARY KEY (provider_id, account_id)
    )
  `)
  return db
}

function makeFreshApiKeyCred(): Credential {
  return {
    providerId: 'openai',
    accountId: 'default',
    type: 'api_key',
    value: 'sk-test-key',
  }
}

function makeOAuthCred(expiresAt: number, refreshToken = 'refresh-token'): Credential {
  return {
    providerId: 'copilot',
    accountId: 'default',
    type: 'oauth',
    value: 'ghu_test_token',
    refreshToken,
    expiresAt,
  }
}

describe('SqliteCredentialStore', () => {
  let db: Database
  let store: SqliteCredentialStore

  beforeEach(() => {
    db = makeInMemoryDb()
    store = new SqliteCredentialStore(db)
  })

  describe('resolve()', () => {
    it('throws CredentialNotFoundError when no credential exists', async () => {
      await expect(store.resolve('openai', 'default')).rejects.toThrow(CredentialNotFoundError)
    })

    it('returns fresh API key credential as-is', async () => {
      const cred = makeFreshApiKeyCred()
      await store.save(cred)
      const resolved = await store.resolve('openai', 'default')
      expect(resolved.value).toBe('sk-test-key')
      expect(resolved.type).toBe('api_key')
    })

    it('returns fresh OAuth token as-is (expires in 1 hour)', async () => {
      const expiresAt = Date.now() + 60 * 60 * 1000  // 1 hour
      const cred = makeOAuthCred(expiresAt)
      await store.save(cred)
      const resolved = await store.resolve('copilot', 'default')
      expect(resolved.value).toBe('ghu_test_token')
    })

    it('triggers refresh when token expires in < 5 minutes', async () => {
      const expiresAt = Date.now() + 3 * 60 * 1000  // 3 min (< 5 min buffer)
      const cred = makeOAuthCred(expiresAt)
      await store.save(cred)

      const refreshedCred: Credential = {
        ...cred,
        value: 'new_token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }

      const mockOAuth: OAuthProvider = {
        fetchToken: mock(async () => refreshedCred),
        refreshToken: mock(async () => refreshedCred),
        startDeviceFlow: mock(async () => { throw new Error('not implemented') }),
        pollOnce: mock(async () => { throw new Error('not implemented') }),
      }

      store.registerOAuthProvider('copilot', mockOAuth)

      const resolved = await store.resolve('copilot', 'default')
      expect(resolved.value).toBe('new_token')
      expect(mockOAuth.refreshToken).toHaveBeenCalledTimes(1)
    })

    it('deduplicates concurrent refresh calls (in-flight promise reuse)', async () => {
      const expiresAt = Date.now() + 1 * 60 * 1000  // 1 min (expiring soon)
      const cred = makeOAuthCred(expiresAt)
      await store.save(cred)

      let refreshCount = 0
      const refreshedCred: Credential = {
        ...cred,
        value: 'refreshed_token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }

      const mockOAuth: OAuthProvider = {
        fetchToken: mock(async () => refreshedCred),
        refreshToken: mock(async () => {
          refreshCount++
          await new Promise(resolve => setTimeout(resolve, 50))  // Simulate async
          return refreshedCred
        }),
        startDeviceFlow: mock(async () => { throw new Error('not implemented') }),
        pollOnce: mock(async () => { throw new Error('not implemented') }),
      }

      store.registerOAuthProvider('copilot', mockOAuth)

      // Fire 3 concurrent resolves
      const [r1, r2, r3] = await Promise.all([
        store.resolve('copilot', 'default'),
        store.resolve('copilot', 'default'),
        store.resolve('copilot', 'default'),
      ])

      // All should get the refreshed token
      expect(r1.value).toBe('refreshed_token')
      expect(r2.value).toBe('refreshed_token')
      expect(r3.value).toBe('refreshed_token')

      // But refresh should only have been called once
      expect(refreshCount).toBe(1)
    })

    it('throws OAuthRevokedError when refresh returns 401', async () => {
      const expiresAt = Date.now() + 1 * 60 * 1000  // expiring
      const cred = makeOAuthCred(expiresAt)
      await store.save(cred)

      const mockOAuth: OAuthProvider = {
        fetchToken: mock(async () => { throw new OAuthRevokedError('copilot', 'default') }),
        refreshToken: mock(async () => { throw new OAuthRevokedError('copilot', 'default') }),
        startDeviceFlow: mock(async () => { throw new Error('not implemented') }),
        pollOnce: mock(async () => { throw new Error('not implemented') }),
      }

      store.registerOAuthProvider('copilot', mockOAuth)

      await expect(store.resolve('copilot', 'default')).rejects.toThrow(OAuthRevokedError)
    })

    it('clears credential from DB after OAuthRevokedError', async () => {
      const expiresAt = Date.now() + 1 * 60 * 1000
      const cred = makeOAuthCred(expiresAt)
      await store.save(cred)

      const mockOAuth: OAuthProvider = {
        fetchToken: mock(async () => { throw new OAuthRevokedError('copilot', 'default') }),
        refreshToken: mock(async () => { throw new OAuthRevokedError('copilot', 'default') }),
        startDeviceFlow: mock(async () => { throw new Error('not implemented') }),
        pollOnce: mock(async () => { throw new Error('not implemented') }),
      }

      store.registerOAuthProvider('copilot', mockOAuth)

      try {
        await store.resolve('copilot', 'default')
      } catch {
        // Expected
      }

      // Credential should now be cleared
      await expect(store.resolve('copilot', 'default')).rejects.toThrow(CredentialNotFoundError)
    })
  })

  describe('save()', () => {
    it('persists and overwrites credential', async () => {
      const cred = makeFreshApiKeyCred()
      await store.save(cred)
      await store.save({ ...cred, value: 'sk-updated' })
      const resolved = await store.resolve('openai', 'default')
      expect(resolved.value).toBe('sk-updated')
    })
  })

  describe('clear()', () => {
    it('removes credential from store', async () => {
      await store.save(makeFreshApiKeyCred())
      await store.clear('openai', 'default')
      await expect(store.resolve('openai', 'default')).rejects.toThrow(CredentialNotFoundError)
    })
  })
})
