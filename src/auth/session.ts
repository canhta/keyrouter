// src/auth/session.ts — Dashboard admin session management
//
// Session lifecycle:
//   ┌─ login ──────────────────────────────────────────────────────────────┐
//   │  bcrypt.verify() → INSERT sessions (token, created_at, expires_at)  │
//   │  set HttpOnly session cookie + JS-readable double-submit CSRF cookie │
//   └──────────────────────────────────────────────────────────────────────┘
//   ┌─ middleware (each /dashboard/* request) ────────────────────────────┐
//   │  read cookie → lookup sessions table → check expires_at            │
//   │  valid → UPDATE expires_at (rolling) → proceed                     │
//   │  expired/missing → 401                                             │
//   └──────────────────────────────────────────────────────────────────────┘
//   ┌─ rate limiting ──────────────────────────────────────────────────────┐
//   │  wrong password → increment login_attempts.count                    │
//   │  count >= 5 → set locked_until = now + 15min                       │
//   │  locked_until <= now → reset count + allow                         │
//   └──────────────────────────────────────────────────────────────────────┘

import type { Database } from 'bun:sqlite'
import type { Context } from 'hono'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days rolling
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000               // 15 minutes

export const SESSION_COOKIE = 'keyrouter_session'
export const CSRF_COOKIE = 'keyrouter_csrf'

export class SessionManager {
  constructor(private db: Database) {}

  // ── Password ─────────────────────────────────────────────────────────────

  async setPassword(password: string): Promise<void> {
    const hash = await Bun.password.hash(password, { algorithm: 'bcrypt' })
    this.db
      .query(`INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(hash)
  }

  async verifyPassword(password: string): Promise<boolean> {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get('admin_password_hash')
    if (!row) return false
    return Bun.password.verify(password, row.value)
  }

  hasPassword(): boolean {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get('admin_password_hash')
    return row !== null
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  checkRateLimit(ip: string): { allowed: boolean; lockedUntil?: number } {
    const row = this.db
      .query<{ count: number; locked_until: number | null }, [string]>(
        'SELECT count, locked_until FROM login_attempts WHERE ip = ?'
      )
      .get(ip)

    if (!row) return { allowed: true }

    const now = Date.now()
    if (row.locked_until && row.locked_until > now) {
      return { allowed: false, lockedUntil: row.locked_until }
    }

    return { allowed: true }
  }

  recordFailedAttempt(ip: string): { locked: boolean; attemptsRemaining: number } {
    const now = Date.now()
    const row = this.db
      .query<{ count: number; locked_until: number | null }, [string]>(
        'SELECT count, locked_until FROM login_attempts WHERE ip = ?'
      )
      .get(ip)

    // If locked_until is null (never locked), keep the running count.
    // If locked_until has expired, the lockout period ended — reset count to 0.
    const prevCount = (row && !row.locked_until) ? row.count : 0
    const newCount = prevCount + 1
    const locked = newCount >= MAX_ATTEMPTS
    const lockedUntil = locked ? now + LOCKOUT_MS : null

    this.db
      .query(
        `INSERT INTO login_attempts (ip, count, locked_until) VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until`
      )
      .run(ip, newCount, lockedUntil)

    return { locked, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - newCount) }
  }

  clearAttempts(ip: string): void {
    this.db.query('DELETE FROM login_attempts WHERE ip = ?').run(ip)
  }

  // ── Session CRUD ──────────────────────────────────────────────────────────

  createSession(): string {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    const now = Date.now()
    this.db
      .query('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
      .run(token, now, now + SESSION_TTL_MS)
    return token
  }

  validateAndRenew(token: string): boolean {
    const row = this.db
      .query<{ expires_at: number }, [string]>(
        'SELECT expires_at FROM sessions WHERE token = ?'
      )
      .get(token)

    if (!row) return false

    const now = Date.now()
    if (row.expires_at < now) {
      this.db.query('DELETE FROM sessions WHERE token = ?').run(token)
      return false
    }

    // Rolling expiry: extend on every valid request
    this.db
      .query('UPDATE sessions SET expires_at = ? WHERE token = ?')
      .run(now + SESSION_TTL_MS, token)

    return true
  }

  deleteSession(token: string): void {
    this.db.query('DELETE FROM sessions WHERE token = ?').run(token)
  }

  // ── Cookie helpers ────────────────────────────────────────────────────────

  setSessionCookies(c: Context, token: string): void {
    const csrfToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    const isSecure = c.req.url.startsWith('https')
    const base = `; Path=/dashboard; SameSite=Strict${isSecure ? '; Secure' : ''}`

    c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly${base}`)
    // CSRF cookie is NOT HttpOnly so JS can read it for the double-submit pattern
    c.header('Set-Cookie', `${CSRF_COOKIE}=${csrfToken}${base}`, { append: true })
  }

  clearSessionCookies(c: Context): void {
    c.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/dashboard; Max-Age=0; SameSite=Strict`)
    c.header('Set-Cookie', `${CSRF_COOKIE}=; Path=/dashboard; Max-Age=0; SameSite=Strict`, { append: true })
  }

  getSessionToken(c: Context): string | null {
    const cookie = c.req.header('cookie') ?? ''
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
    return match?.[1] ?? null
  }

  /** Double-submit CSRF check: cookie value must match X-CSRF-Token header (timing-safe). */
  verifyCsrf(c: Context): boolean {
    const cookie = c.req.header('cookie') ?? ''
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`))
    const cookieVal = match?.[1]
    const headerVal = c.req.header('x-csrf-token')

    if (!cookieVal || !headerVal || cookieVal.length !== headerVal.length) return false

    const encoder = new TextEncoder()
    const a = encoder.encode(cookieVal)
    const b = encoder.encode(headerVal)
    let mismatch = 0
    for (let i = 0; i < a.length; i++) mismatch |= a[i]! ^ b[i]!
    return mismatch === 0
  }
}
