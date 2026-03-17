// src/handlers/dashboard.ts — Dashboard HTML serving + first-run/login redirects

import type { Context } from 'hono'
import type { SessionManager } from '../auth/session.ts'
import * as path from 'node:path'
import * as fs from 'node:fs'

// Serve from dist/ui/pages/ (built by `bun build`), fall back to src/ui/pages/ in dev
function getDashboardHtml(page: string): string {
  const distPath = path.join(process.cwd(), 'dist', 'ui', 'pages', `${page}.html`)
  const srcPath = path.join(process.cwd(), 'src', 'ui', 'pages', `${page}.html`)
  const filePath = fs.existsSync(distPath) ? distPath : srcPath
  return fs.readFileSync(filePath, 'utf8')
}

export function createDashboardHandler(sessionManager: SessionManager) {
  return (c: Context) => {
    // First run: no password set yet
    if (!sessionManager.hasPassword()) {
      return c.redirect('/dashboard/setup')
    }

    // Not authenticated
    const token = sessionManager.getSessionToken(c)
    if (!token || !sessionManager.validateAndRenew(token)) {
      return c.redirect('/dashboard/login')
    }

    const html = getDashboardHtml('home')
    return c.html(html)
  }
}

function createPageHandler(sessionManager: SessionManager, page: string) {
  return (c: Context) => {
    // First run: no password set yet
    if (!sessionManager.hasPassword()) {
      return c.redirect('/dashboard/setup')
    }

    // Not authenticated
    const token = sessionManager.getSessionToken(c)
    if (!token || !sessionManager.validateAndRenew(token)) {
      return c.redirect('/dashboard/login')
    }

    const html = getDashboardHtml(page)
    return c.html(html)
  }
}

export function createMonitorPageHandler(sessionManager: SessionManager) {
  return createPageHandler(sessionManager, 'monitor')
}

export function createConfigPageHandler(sessionManager: SessionManager) {
  return createPageHandler(sessionManager, 'config')
}

export function createAuthPageHandler(sessionManager: SessionManager) {
  return createPageHandler(sessionManager, 'auth')
}

export function createUsagePageHandler(sessionManager: SessionManager) {
  return createPageHandler(sessionManager, 'usage')
}

const AUTH_PAGE_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'JetBrains Mono', monospace;
    background: #0d0f14;
    color: #dde1ed;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1rem;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: #13161f;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 2rem;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
  }
  .logo-mark {
    width: 24px;
    height: 24px;
    background: #f59e0b;
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-weight: 700;
    color: #000;
  }
  .logo-name { font-size: 1rem; font-weight: 700; letter-spacing: 0.06em; }
  .subtitle { font-size: 0.78rem; color: #525870; margin-bottom: 1.75rem; }
  label {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #525870;
    display: block;
    margin-bottom: 0.35rem;
  }
  input {
    width: 100%;
    background: #1a1e2a;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #dde1ed;
    padding: 0.6rem 0.75rem;
    font-family: inherit;
    font-size: 0.85rem;
    margin-bottom: 1rem;
    transition: border-color 0.15s;
  }
  input:focus { outline: none; border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.12); }
  button {
    width: 100%;
    background: #f59e0b;
    border: none;
    border-radius: 6px;
    color: #000;
    padding: 0.65rem;
    font-family: inherit;
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: 0.04em;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.88; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .error {
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.25);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.78rem;
    color: #ef4444;
  }
`

export function createSetupPageHandler() {
  return (_c: Context) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Keyrouter — Setup</title>
  <style>${AUTH_PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span class="logo-mark">K</span>
      <span class="logo-name">Keyrouter</span>
    </div>
    <p class="subtitle">First run — set an admin password</p>
    <div id="error" class="error" style="display:none"></div>
    <form id="form">
      <label for="password">Admin Password</label>
      <input type="password" id="password" name="password" minlength="8" required autocomplete="new-password" placeholder="min. 8 characters">
      <label for="confirm">Confirm Password</label>
      <input type="password" id="confirm" name="confirm" minlength="8" required autocomplete="new-password" placeholder="repeat password">
      <button type="submit" id="btn">Set Password →</button>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const pw = document.getElementById('password').value
      const confirm = document.getElementById('confirm').value
      const errorEl = document.getElementById('error')
      const btn = document.getElementById('btn')
      if (pw !== confirm) { errorEl.textContent = 'Passwords do not match'; errorEl.style.display = 'block'; return }
      if (pw.length < 8) { errorEl.textContent = 'Password must be at least 8 characters'; errorEl.style.display = 'block'; return }
      errorEl.style.display = 'none'
      btn.disabled = true; btn.textContent = 'Setting up…'
      const r = await fetch('/dashboard/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      if (r.ok) { window.location.href = '/dashboard/login' }
      else { const d = await r.json(); errorEl.textContent = d.error || 'Setup failed'; errorEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Set Password →' }
    })
  </script>
</body>
</html>`
    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  }
}

export function createLoginPageHandler() {
  return (_c: Context) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Keyrouter — Login</title>
  <style>${AUTH_PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span class="logo-mark">K</span>
      <span class="logo-name">Keyrouter</span>
    </div>
    <p class="subtitle">Admin login</p>
    <div id="error" class="error" style="display:none"></div>
    <form id="form">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="••••••••">
      <button type="submit" id="btn">Login →</button>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const pw = document.getElementById('password').value
      const errorEl = document.getElementById('error')
      const btn = document.getElementById('btn')
      errorEl.style.display = 'none'
      btn.disabled = true; btn.textContent = 'Logging in…'
      const r = await fetch('/dashboard/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      if (r.ok) { window.location.href = '/dashboard' }
      else { const d = await r.json(); errorEl.textContent = d.error || 'Login failed'; errorEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Login →' }
    })
  </script>
</body>
</html>`
    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  }
}

export function createSetupSubmitHandler(sessionManager: SessionManager) {
  return async (c: Context) => {
    let body: { password?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const password = body.password ?? ''
    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400)
    }

    await sessionManager.setPassword(password)
    return c.json({ ok: true })
  }
}

export function createLoginSubmitHandler(sessionManager: SessionManager) {
  return async (c: Context) => {
    const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown'

    const limit = sessionManager.checkRateLimit(ip)
    if (!limit.allowed) {
      const waitMin = Math.ceil(((limit.lockedUntil ?? 0) - Date.now()) / 60_000)
      return c.json({ error: `Too many attempts. Try again in ${waitMin} minutes.` }, 429)
    }

    let body: { password?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const valid = await sessionManager.verifyPassword(body.password ?? '')
    if (!valid) {
      const { locked, attemptsRemaining } = sessionManager.recordFailedAttempt(ip)
      if (locked) {
        return c.json({ error: 'Too many failed attempts. Locked for 15 minutes.' }, 429)
      }
      return c.json({ error: `Incorrect password. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} remaining.` }, 401)
    }

    sessionManager.clearAttempts(ip)
    const token = sessionManager.createSession()
    sessionManager.setSessionCookies(c, token)
    return c.json({ ok: true })
  }
}

export function createLogoutHandler(sessionManager: SessionManager) {
  return (c: Context) => {
    const token = sessionManager.getSessionToken(c)
    if (token) sessionManager.deleteSession(token)
    sessionManager.clearSessionCookies(c)
    return c.redirect('/dashboard/login')
  }
}
