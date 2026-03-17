import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SessionManager } from '../../src/auth/session.ts'

function makeDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE sessions (
      token       TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE login_attempts (
      ip           TEXT PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )
  `)
  db.run(`
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  return db
}

describe('SessionManager — password', () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager(makeDb())
  })

  it('hasPassword() returns false before setup', () => {
    expect(mgr.hasPassword()).toBe(false)
  })

  it('hasPassword() returns true after setPassword()', async () => {
    await mgr.setPassword('correcthorse')
    expect(mgr.hasPassword()).toBe(true)
  })

  it('verifyPassword() returns true for correct password', async () => {
    await mgr.setPassword('correcthorse')
    expect(await mgr.verifyPassword('correcthorse')).toBe(true)
  })

  it('verifyPassword() returns false for wrong password', async () => {
    await mgr.setPassword('correcthorse')
    expect(await mgr.verifyPassword('wrong')).toBe(false)
  })
})

describe('SessionManager — sessions', () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager(makeDb())
  })

  it('createSession() returns a 64-char hex token', () => {
    const token = mgr.createSession()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('validateAndRenew() returns true for a fresh session', () => {
    const token = mgr.createSession()
    expect(mgr.validateAndRenew(token)).toBe(true)
  })

  it('validateAndRenew() returns false for unknown token', () => {
    expect(mgr.validateAndRenew('not-a-token')).toBe(false)
  })

  it('deleteSession() invalidates the session', () => {
    const token = mgr.createSession()
    mgr.deleteSession(token)
    expect(mgr.validateAndRenew(token)).toBe(false)
  })

  it('validateAndRenew() returns false and deletes expired session', () => {
    const db = makeDb()
    const mgr2 = new SessionManager(db)
    const token = mgr2.createSession()
    // Manually expire it
    db.query('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token)
    expect(mgr2.validateAndRenew(token)).toBe(false)
    // Confirm it was deleted
    const row = db.query('SELECT token FROM sessions WHERE token = ?').get(token)
    expect(row).toBeNull()
  })
})

describe('SessionManager — rate limiting', () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager(makeDb())
  })

  it('checkRateLimit() allows unknown IP', () => {
    expect(mgr.checkRateLimit('1.2.3.4').allowed).toBe(true)
  })

  it('locks after 5 failed attempts', () => {
    for (let i = 0; i < 4; i++) {
      mgr.recordFailedAttempt('1.2.3.4')
      expect(mgr.checkRateLimit('1.2.3.4').allowed).toBe(true)
    }
    const { locked } = mgr.recordFailedAttempt('1.2.3.4')
    expect(locked).toBe(true)
    expect(mgr.checkRateLimit('1.2.3.4').allowed).toBe(false)
  })

  it('clearAttempts() allows login again after lockout', () => {
    for (let i = 0; i < 5; i++) mgr.recordFailedAttempt('1.2.3.4')
    expect(mgr.checkRateLimit('1.2.3.4').allowed).toBe(false)
    mgr.clearAttempts('1.2.3.4')
    expect(mgr.checkRateLimit('1.2.3.4').allowed).toBe(true)
  })

  it('lockout expiry: resets count when locked_until has passed', () => {
    const db = makeDb()
    const mgr2 = new SessionManager(db)
    // Fill to 5 attempts — should be locked
    for (let i = 0; i < 5; i++) mgr2.recordFailedAttempt('5.6.7.8')
    expect(mgr2.checkRateLimit('5.6.7.8').allowed).toBe(false)

    // Manually expire the lockout
    db.query('UPDATE login_attempts SET locked_until = ? WHERE ip = ?').run(Date.now() - 1000, '5.6.7.8')

    // Should be allowed now
    expect(mgr2.checkRateLimit('5.6.7.8').allowed).toBe(true)

    // And a subsequent failed attempt should reset the count to 1
    const { locked, attemptsRemaining } = mgr2.recordFailedAttempt('5.6.7.8')
    expect(locked).toBe(false)
    expect(attemptsRemaining).toBe(4)
  })
})
