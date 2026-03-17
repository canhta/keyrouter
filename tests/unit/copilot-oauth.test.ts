import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CopilotOAuth } from '../../src/auth/copilot.ts'
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

function mockFetch(responses: Record<string, unknown>, status = 200) {
  let callIndex = 0
  const responseList = Object.values(responses)
  globalThis.fetch = mock(() => {
    const body = responseList[callIndex++] ?? {}
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }))
  }) as unknown as typeof fetch
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('CopilotOAuth.startDeviceFlow()', () => {
  it('returns DeviceFlowStart from the device code endpoint', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CopilotOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      device_code: 'dev-code-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as unknown as typeof fetch

    const result = await oauth.startDeviceFlow()
    expect(result.deviceCode).toBe('dev-code-123')
    expect(result.userCode).toBe('ABCD-EFGH')
    expect(result.verificationUri).toBe('https://github.com/login/device')
    expect(result.expiresIn).toBe(900)
    expect(result.interval).toBe(5)
  })

  it('throws OAuthClientError when device code request fails', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CopilotOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response('{}', { status: 503 }))) as unknown as typeof fetch

    await expect(oauth.startDeviceFlow()).rejects.toThrow(OAuthClientError)
  })
})

describe('CopilotOAuth.pollOnce()', () => {
  it('returns pending when authorization_pending', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CopilotOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'authorization_pending',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as unknown as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })
    expect(result.status).toBe('pending')
  })

  it('returns slow_down when server asks to slow down', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CopilotOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'slow_down',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as unknown as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })
    expect(result.status).toBe('slow_down')
  })

  it('returns expired when device code expires', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CopilotOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'expired_token',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as unknown as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })
    expect(result.status).toBe('expired')
  })

  it('throws OAuthClientError on unexpected error field', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CopilotOAuth(store)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'access_denied',
      error_description: 'User denied access',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as unknown as typeof fetch

    await expect(oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })).rejects.toThrow(OAuthClientError)
  })

  it('saves credential and returns success on valid token', async () => {
    const db = makeDb()
    const store = new SqliteCredentialStore(db)
    const oauth = new CopilotOAuth(store)

    let callCount = 0
    globalThis.fetch = mock(() => {
      callCount++
      if (callCount === 1) {
        // Token endpoint
        return Promise.resolve(new Response(JSON.stringify({
          access_token: 'gho_github_token',
          refresh_token: 'ghr_refresh',
          expires_in: 28800,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      // Copilot exchange endpoint
      return Promise.resolve(new Response(JSON.stringify({
        token: 'tid=copilot_token',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }) as unknown as typeof fetch

    const result = await oauth.pollOnce({ deviceCode: 'dev', accountId: 'user1' })
    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.credential.providerId).toBe('copilot')
      expect(result.credential.accountId).toBe('user1')
      expect(result.credential.type).toBe('oauth')
    }
  })
})
