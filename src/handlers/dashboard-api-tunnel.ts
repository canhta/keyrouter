// src/handlers/dashboard-api-tunnel.ts — POST /dashboard/tunnel/start, /stop

import type { Context } from 'hono'
import type { SessionManager } from '../auth/session.ts'
import type { TunnelManager } from '../tunnel/manager.ts'
import { TunnelAlreadyRunningError, TunnelStartError, CloudflaredNotFoundError } from '../tunnel/manager.ts'

export function createTunnelStartHandler(
  sessionManager: SessionManager,
  tunnelManager: TunnelManager
) {
  return async (c: Context) => {
    if (!sessionManager.verifyCsrf(c)) {
      return c.json({ error: 'Invalid CSRF token' }, 403)
    }

    try {
      const url = await tunnelManager.start()
      return c.json({ url })
    } catch (err) {
      if (err instanceof TunnelAlreadyRunningError) {
        return c.json({ error: 'Tunnel is already running', url: tunnelManager.url }, 409)
      }
      if (err instanceof CloudflaredNotFoundError) {
        return c.json({
          error: 'cloudflared not found',
          instructions: 'Install with: brew install cloudflared  OR  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
        }, 400)
      }
      if (err instanceof TunnelStartError) {
        return c.json({ error: 'Tunnel failed to start within 30 seconds' }, 504)
      }
      console.error('[keyrouter] tunnel start failed:', err)
      return c.json({ error: 'Tunnel start failed' }, 500)
    }
  }
}

export function createTunnelStopHandler(
  sessionManager: SessionManager,
  tunnelManager: TunnelManager
) {
  return (c: Context) => {
    if (!sessionManager.verifyCsrf(c)) {
      return c.json({ error: 'Invalid CSRF token' }, 403)
    }

    if (!tunnelManager.running) {
      return c.json({ error: 'Tunnel is not running' }, 404)
    }

    tunnelManager.stop()
    return c.json({ ok: true })
  }
}

export function createTunnelStatusHandler(tunnelManager: TunnelManager) {
  return (c: Context) => {
    return c.json({ running: tunnelManager.running, url: tunnelManager.url })
  }
}
