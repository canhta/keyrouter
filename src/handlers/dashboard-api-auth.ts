// src/handlers/dashboard-api-auth.ts — OAuth device flow via dashboard
//
// Device flow (two-phase):
//   POST /dashboard/api/auth/start { provider, accountId }
//     → calls provider.startDeviceFlow()
//     → stores DeviceFlowState in inflight Map keyed by userCode
//     → returns { userCode, verificationUri, expiresIn }
//
//   GET /dashboard/api/auth/status/:userCode
//     → looks up inflight Map
//     → calls provider.pollOnce()
//     → returns { status: 'pending' | 'success' | 'expired' }
//
//   POST /dashboard/api/auth/cancel { userCode }
//     → removes from inflight Map

import type { Context } from 'hono'
import type { SessionManager } from '../auth/session.ts'
import type { SqliteCredentialStore } from '../auth/store.ts'
import type { DeviceFlowState } from '../types.ts'

export function createDashboardAuthHandlers(
  sessionManager: SessionManager,
  credentialStore: SqliteCredentialStore
) {
  // In-memory map of active device flows: userCode → state
  const inflight = new Map<string, DeviceFlowState>()

  const startHandler = async (c: Context) => {
    if (!sessionManager.verifyCsrf(c)) {
      return c.json({ error: 'Invalid CSRF token' }, 403)
    }

    let body: { provider?: string; accountId?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const { provider, accountId } = body
    if (!provider || !accountId) {
      return c.json({ error: 'provider and accountId are required' }, 400)
    }

    const oauthProvider = credentialStore.getOAuthProvider(provider)
    if (!oauthProvider) {
      return c.json({ error: `Provider '${provider}' not found or does not support OAuth` }, 400)
    }

    let flowStart
    try {
      flowStart = await oauthProvider.startDeviceFlow()
    } catch (err) {
      console.error('[keyrouter] startDeviceFlow failed:', err)
      return c.json({ error: 'Failed to start device flow' }, 502)
    }

    const state: DeviceFlowState = {
      deviceCode: flowStart.deviceCode,
      userCode: flowStart.userCode,
      verificationUri: flowStart.verificationUri,
      deadline: Date.now() + flowStart.expiresIn * 1000,
      intervalMs: flowStart.interval * 1000,
      providerId: provider,
      accountId,
      codeVerifier: flowStart.codeVerifier,
    }

    inflight.set(flowStart.userCode, state)

    // Auto-cleanup when deadline passes
    setTimeout(() => inflight.delete(flowStart.userCode), flowStart.expiresIn * 1000 + 5000)

    return c.json({
      userCode: flowStart.userCode,
      verificationUri: flowStart.verificationUri,
      expiresIn: flowStart.expiresIn,
    })
  }

  const statusHandler = async (c: Context) => {
    const userCode = c.req.param('userCode') ?? ''
    const state = inflight.get(userCode)

    if (!state) return c.json({ error: 'Device flow not found or expired' }, 404)

    if (Date.now() > state.deadline) {
      inflight.delete(userCode)
      return c.json({ status: 'expired' }, 410)
    }

    const oauthProvider = credentialStore.getOAuthProvider(state.providerId)
    if (!oauthProvider) {
      inflight.delete(userCode)
      return c.json({ error: 'Provider no longer available' }, 400)
    }

    let result
    try {
      result = await oauthProvider.pollOnce({
        deviceCode: state.deviceCode,
        accountId: state.accountId,
        codeVerifier: state.codeVerifier,
      })
    } catch (err) {
      console.error('[keyrouter] pollOnce failed:', err)
      return c.json({ error: 'Poll failed' }, 502)
    }

    if (result.status === 'slow_down') {
      state.intervalMs += 5000
      return c.json({ status: 'pending', nextPollMs: state.intervalMs })
    }

    if (result.status === 'expired') {
      inflight.delete(userCode)
      return c.json({ status: 'expired' }, 410)
    }

    if (result.status === 'success') {
      inflight.delete(userCode)
      return c.json({ status: 'success' })
    }

    return c.json({ status: 'pending', nextPollMs: state.intervalMs })
  }

  const cancelHandler = (c: Context) => {
    if (!sessionManager.verifyCsrf(c)) {
      return c.json({ error: 'Invalid CSRF token' }, 403)
    }

    const userCode = c.req.param('userCode') ?? ''
    if (userCode) inflight.delete(userCode)

    return c.json({ ok: true })
  }

  return { startHandler, statusHandler, cancelHandler }
}
