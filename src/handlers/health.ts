// src/handlers/health.ts — GET /health (Railway health check)

import type { Context } from 'hono'

export function createHealthHandler() {
  return (c: Context) => {
    return c.json({ status: 'ok', uptime: Math.floor(process.uptime()) })
  }
}
