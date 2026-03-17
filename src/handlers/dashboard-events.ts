// src/handlers/dashboard-events.ts — GET /dashboard/events (SSE stream to browser)

import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { DashboardEventBus } from '../events/bus.ts'
import type { SessionManager } from '../auth/session.ts'
import type { DashboardEvent } from '../types.ts'

export function createDashboardEventsHandler(
  sessionManager: SessionManager,
  bus: DashboardEventBus
) {
  return (c: Context) => {
    // Auth check
    const token = sessionManager.getSessionToken(c)
    if (!token || !sessionManager.validateAndRenew(token)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    return streamSSE(c, async (stream) => {
      // Queue for bridging pub/sub events into the async stream
      const queue: DashboardEvent[] = []
      let resolve: (() => void) | null = null

      const unsubscribe = bus.subscribe((event) => {
        queue.push(event)
        resolve?.()
        resolve = null
      })

      stream.onAbort(() => {
        unsubscribe()
      })

      try {
        while (true) {
          // Drain queued events
          while (queue.length > 0) {
            const event = queue.shift()!
            await stream.writeSSE({ data: JSON.stringify(event) })
          }

          // Wait up to 10s for a new event, then send keepalive ping
          await Promise.race([
            new Promise<void>((r) => { resolve = r }),
            new Promise<void>((r) => setTimeout(r, 10_000)),
          ])

          // If no event arrived, send a keepalive comment
          if (queue.length === 0) {
            await stream.write(': ping\n\n')
          }
        }
      } finally {
        unsubscribe()
      }
    })
  }
}
