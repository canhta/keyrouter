import { describe, it, expect } from 'bun:test'
import { DashboardEventBus } from '../../src/events/bus.ts'

describe('DashboardEventBus', () => {
  it('starts with 0 subscribers', () => {
    const bus = new DashboardEventBus()
    expect(bus.size).toBe(0)
  })

  it('subscribe increments size, unsubscribe decrements it', () => {
    const bus = new DashboardEventBus()
    const unsub = bus.subscribe(() => {})
    expect(bus.size).toBe(1)
    unsub()
    expect(bus.size).toBe(0)
  })

  it('publish delivers event to all subscribers', () => {
    const bus = new DashboardEventBus()
    const received: unknown[] = []
    bus.subscribe(e => received.push(e))
    bus.subscribe(e => received.push(e))

    const event = { type: 'request' as const, data: { model: 'm', provider: 'p', account: 'a', status: 200, latencyMs: 10, tokens: 100 } }
    bus.publish(event)
    expect(received).toHaveLength(2)
    expect(received[0]).toEqual(event)
  })

  it('publish is a no-op when no subscribers', () => {
    const bus = new DashboardEventBus()
    // Should not throw
    bus.publish({ type: 'tunnel', data: { url: null } })
  })

  it('subscriber error does not affect other subscribers', () => {
    const bus = new DashboardEventBus()
    const received: unknown[] = []
    bus.subscribe(() => { throw new Error('boom') })
    bus.subscribe(e => received.push(e))

    bus.publish({ type: 'tunnel', data: { url: 'https://example.trycloudflare.com' } })
    expect(received).toHaveLength(1)
  })

  it('unsubscribed listener does not receive further events', () => {
    const bus = new DashboardEventBus()
    const received: unknown[] = []
    const unsub = bus.subscribe(e => received.push(e))

    bus.publish({ type: 'tunnel', data: { url: null } })
    unsub()
    bus.publish({ type: 'tunnel', data: { url: null } })

    expect(received).toHaveLength(1)
  })
})
