// src/handlers/dashboard-events.ts — GET /dashboard/events (SSE stream to browser)

import type { Context } from 'hono'
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

    let unsubscribe: (() => void) | null = null

    const stream = new ReadableStream({
      start(controller) {
        const encode = (event: DashboardEvent) => {
          const data = `data: ${JSON.stringify(event)}\n\n`
          controller.enqueue(new TextEncoder().encode(data))
        }

        // Send a heartbeat immediately so the browser knows the connection is live
        controller.enqueue(new TextEncoder().encode(': connected\n\n'))

        unsubscribe = bus.subscribe(encode)
      },
      cancel() {
        unsubscribe?.()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }
}
