// src/handlers/dashboard.ts — Dashboard HTML serving + first-run/login redirects

import type { Context } from 'hono'
import type { SessionManager } from '../auth/session.ts'
import * as path from 'node:path'
import * as fs from 'node:fs'

// Serve from dist/ui/ (built by `bun build`), fall back to src/ui/ in dev
function getDashboardHtml(): string {
  const distPath = path.join(process.cwd(), 'dist', 'ui', 'dashboard.html')
  const srcPath = path.join(process.cwd(), 'src', 'ui', 'dashboard.html')
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

    const html = getDashboardHtml()
    return c.html(html)
  }
}

export function createSetupPageHandler() {
  return (_c: Context) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KEYROUTER — Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: monospace; background: #fff; color: #000; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { border: 4px solid #000; padding: 2rem; width: 100%; max-width: 420px; box-shadow: 6px 6px 0 #000; }
    h1 { font-size: 1.5rem; font-weight: 900; letter-spacing: 0.1em; margin-bottom: 0.25rem; }
    p { font-size: 0.85rem; margin-bottom: 1.5rem; }
    label { font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem; }
    input { width: 100%; border: 2px solid #000; padding: 0.5rem; font-family: monospace; font-size: 1rem; margin-bottom: 1rem; }
    input:focus { outline: 2px solid #000; outline-offset: 2px; }
    button { width: 100%; border: 2px solid #000; background: #000; color: #fff; padding: 0.6rem; font-family: monospace; font-size: 1rem; font-weight: 700; cursor: pointer; letter-spacing: 0.05em; }
    button:hover { background: #fff; color: #000; }
    .error { background: #ff0; border: 2px solid #000; padding: 0.5rem; margin-bottom: 1rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>KEYROUTER</h1>
    <p>First run. Set an admin password.</p>
    <div id="error" class="error" style="display:none"></div>
    <form id="form">
      <label for="password">ADMIN PASSWORD</label>
      <input type="password" id="password" name="password" minlength="8" required autocomplete="new-password">
      <label for="confirm">CONFIRM PASSWORD</label>
      <input type="password" id="confirm" name="confirm" minlength="8" required autocomplete="new-password">
      <button type="submit">SET PASSWORD →</button>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const pw = document.getElementById('password').value
      const confirm = document.getElementById('confirm').value
      const errorEl = document.getElementById('error')
      if (pw !== confirm) { errorEl.textContent = 'Passwords do not match'; errorEl.style.display = ''; return }
      if (pw.length < 8) { errorEl.textContent = 'Password must be at least 8 characters'; errorEl.style.display = ''; return }
      errorEl.style.display = 'none'
      const r = await fetch('/dashboard/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      if (r.ok) { window.location.href = '/dashboard/login' }
      else { const d = await r.json(); errorEl.textContent = d.error || 'Setup failed'; errorEl.style.display = '' }
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
  <title>KEYROUTER — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: monospace; background: #fff; color: #000; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { border: 4px solid #000; padding: 2rem; width: 100%; max-width: 380px; box-shadow: 6px 6px 0 #000; }
    h1 { font-size: 1.5rem; font-weight: 900; letter-spacing: 0.1em; margin-bottom: 0.25rem; }
    p { font-size: 0.85rem; margin-bottom: 1.5rem; }
    label { font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem; }
    input { width: 100%; border: 2px solid #000; padding: 0.5rem; font-family: monospace; font-size: 1rem; margin-bottom: 1rem; }
    input:focus { outline: 2px solid #000; outline-offset: 2px; }
    button { width: 100%; border: 2px solid #000; background: #000; color: #fff; padding: 0.6rem; font-family: monospace; font-size: 1rem; font-weight: 700; cursor: pointer; letter-spacing: 0.05em; }
    button:hover { background: #fff; color: #000; }
    .error { background: #ff0; border: 2px solid #000; padding: 0.5rem; margin-bottom: 1rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>KEYROUTER</h1>
    <p>Admin login</p>
    <div id="error" class="error" style="display:none"></div>
    <form id="form">
      <label for="password">PASSWORD</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">LOGIN →</button>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const pw = document.getElementById('password').value
      const errorEl = document.getElementById('error')
      errorEl.style.display = 'none'
      const r = await fetch('/dashboard/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      if (r.ok) { window.location.href = '/dashboard' }
      else { const d = await r.json(); errorEl.textContent = d.error || 'Login failed'; errorEl.style.display = '' }
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
