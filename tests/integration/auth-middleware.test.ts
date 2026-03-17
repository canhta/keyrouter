import { describe, it, expect } from 'bun:test'
import { Hono } from 'hono'

function makeAppWithApiKey(apiKey: string | undefined): Hono {
  const app = new Hono()

  if (apiKey) {
    app.use('/v1/*', async (c, next) => {
      const authHeader = c.req.header('authorization') ?? ''
      const incoming = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader

      const encoder = new TextEncoder()
      const a = encoder.encode(incoming)
      const b = encoder.encode(apiKey)

      let mismatch = a.length !== b.length ? 1 : 0
      const len = Math.min(a.length, b.length)
      for (let i = 0; i < len; i++) {
        mismatch |= a[i]! ^ b[i]!
      }

      if (mismatch !== 0) {
        return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: '401' } }, 401)
      }
      return next()
    })
  }

  app.get('/v1/models', (c) => c.json({ object: 'list', data: [] }))

  return app
}

describe('Auth Middleware', () => {
  describe('with API key configured', () => {
    const app = makeAppWithApiKey('test-secret-key')

    it('returns 200 for valid API key', async () => {
      const req = new Request('http://localhost/v1/models', {
        headers: { 'authorization': 'Bearer test-secret-key' },
      })
      const res = await app.fetch(req)
      expect(res.status).toBe(200)
    })

    it('returns 200 for valid API key without Bearer prefix', async () => {
      const req = new Request('http://localhost/v1/models', {
        headers: { 'authorization': 'test-secret-key' },
      })
      const res = await app.fetch(req)
      expect(res.status).toBe(200)
    })

    it('returns 401 for invalid API key', async () => {
      const req = new Request('http://localhost/v1/models', {
        headers: { 'authorization': 'Bearer wrong-key' },
      })
      const res = await app.fetch(req)
      expect(res.status).toBe(401)
      const json = await res.json() as { error: { message: string } }
      expect(json.error.message).toBe('Invalid API key')
    })

    it('returns 401 for empty API key', async () => {
      const req = new Request('http://localhost/v1/models')
      const res = await app.fetch(req)
      expect(res.status).toBe(401)
    })

    it('returns 401 for partial key match', async () => {
      const req = new Request('http://localhost/v1/models', {
        headers: { 'authorization': 'Bearer test-secret' },
      })
      const res = await app.fetch(req)
      expect(res.status).toBe(401)
    })
  })

  describe('without API key configured', () => {
    const app = makeAppWithApiKey(undefined)

    it('passes through all requests without auth check', async () => {
      const req = new Request('http://localhost/v1/models')
      const res = await app.fetch(req)
      expect(res.status).toBe(200)
    })

    it('passes through even with incorrect auth header', async () => {
      const req = new Request('http://localhost/v1/models', {
        headers: { 'authorization': 'Bearer any-random-key' },
      })
      const res = await app.fetch(req)
      expect(res.status).toBe(200)
    })
  })
})
