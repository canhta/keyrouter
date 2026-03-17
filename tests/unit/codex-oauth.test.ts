import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CodexOAuth } from '../../src/auth/codex.ts'
import { SqliteCredentialStore } from '../../src/auth/store.ts'
import { OAuthClientError } from '../../src/types.ts'

function makeDb(): Database {
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

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('CodexOAuth.startDeviceFlow()', () => {
  it('returns DeviceFlowStart with device_auth_id and user_code', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      device_auth_id: 'codex-dev-auth-id',
      user_code: 'WXYZ-1234',
      interval: '5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as unknown as typeof fetch

    const result = await oauth.startDeviceFlow()
    expect(result.deviceCode).toBe('codex-dev-auth-id')
    expect(result.userCode).toBe('WXYZ-1234')
    expect(result.expiresIn).toBe(900)
    expect(result.interval).toBe(5)
    expect(result.verificationUri).toBe('https://auth.openai.com/codex/device')
  })

  it('throws OAuthClientError when auth endpoint fails', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response('{}', { status: 400 }))) as unknown as typeof fetch

    await expect(oauth.startDeviceFlow()).rejects.toThrow(OAuthClientError)
  })
})

describe('CodexOAuth.pollOnce()', () => {
  it('returns pending when poll returns 403', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(
      new Response('', { status: 403 })
    )) as unknown as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev-id', userCode: 'ABCD', accountId: 'user1' })
    expect(result.status).toBe('pending')
  })

  it('returns pending when poll returns 404', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(
      new Response('', { status: 404 })
    )) as unknown as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev-id', userCode: 'ABCD', accountId: 'user1' })
    expect(result.status).toBe('pending')
  })

  it('saves credential and returns success on authorization code + token exchange', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    let callCount = 0
    globalThis.fetch = mock(() => {
      callCount++
      if (callCount === 1) {
        // Poll response: authorization code
        return Promise.resolve(new Response(JSON.stringify({
          authorization_code: 'auth-code-123',
          code_challenge: 'challenge-abc',
          code_verifier: 'verifier-xyz',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      // Token exchange response
      return Promise.resolve(new Response(JSON.stringify({
        id_token: 'eyJ_id_token',
        access_token: 'eyJ_access_token',
        refresh_token: 'eyJ_refresh_token',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }) as unknown as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev-id', userCode: 'ABCD', accountId: 'user1' })
    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.credential.providerId).toBe('codex')
      expect(result.credential.accountId).toBe('user1')
      expect(result.credential.type).toBe('oauth')
      expect(result.credential.value).toBe('eyJ_access_token')
      expect(result.credential.refreshToken).toBe('eyJ_refresh_token')
    }
    expect(callCount).toBe(2)
  })

  it('throws OAuthClientError on unexpected poll status', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(
      new Response('Server Error', { status: 500 })
    )) as unknown as typeof fetch

    await expect(
      oauth.pollOnce({ deviceCode: 'dev-id', userCode: 'ABCD', accountId: 'user1' })
    ).rejects.toThrow(OAuthClientError)
  })
})
