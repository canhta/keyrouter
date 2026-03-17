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
  it('returns DeviceFlowStart including codeVerifier', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      device_code: 'codex-dev-code',
      user_code: 'WXYZ-1234',
      verification_uri: 'https://auth.openai.com/activate',
      expires_in: 600,
      interval: 5,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof fetch

    const result = await oauth.startDeviceFlow()
    expect(result.deviceCode).toBe('codex-dev-code')
    expect(result.userCode).toBe('WXYZ-1234')
    expect(result.expiresIn).toBe(600)
    // PKCE: codeVerifier must be returned so inflight map can thread it to pollOnce
    expect(result.codeVerifier).toBeDefined()
    expect(typeof result.codeVerifier).toBe('string')
    expect(result.codeVerifier!.length).toBeGreaterThan(0)
  })

  it('throws OAuthClientError when auth endpoint fails', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response('{}', { status: 400 }))) as typeof fetch

    await expect(oauth.startDeviceFlow()).rejects.toThrow(OAuthClientError)
  })
})

describe('CodexOAuth.pollOnce()', () => {
  it('returns pending on authorization_pending', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'authorization_pending',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })
    expect(result.status).toBe('pending')
  })

  it('returns slow_down on slow_down error', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'slow_down',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })
    expect(result.status).toBe('slow_down')
  })

  it('returns expired on expired_token', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'expired_token',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })
    expect(result.status).toBe('expired')
  })

  it('saves credential and returns success on valid token', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CodexOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      access_token: 'eyJ_access_token',
      refresh_token: 'eyJ_refresh_token',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1', codeVerifier: 'verifier123' })
    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.credential.providerId).toBe('codex')
      expect(result.credential.accountId).toBe('user1')
      expect(result.credential.type).toBe('oauth')
    }
  })
})
