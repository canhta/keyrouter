// src/events/bus.ts — DashboardEventBus: in-memory pub/sub
//
// DashboardEventBus:
//   subscribers: Set<(event: DashboardEvent) => void>
//   publish(event) → if Set.size === 0: no-op
//                  → else: iterate Set, call each subscriber (errors swallowed)
//   subscribe(fn)  → Set.add(fn); return () => Set.delete(fn)  [cleanup fn]

import type { DashboardEvent } from '../types.ts'

type Subscriber = (event: DashboardEvent) => void

export class DashboardEventBus {
  private subscribers = new Set<Subscriber>()

  publish(event: DashboardEvent): void {
    if (this.subscribers.size === 0) return
    for (const sub of this.subscribers) {
      try { sub(event) } catch { /* never let a subscriber crash the bus */ }
    }
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  get size(): number {
    return this.subscribers.size
  }
}
