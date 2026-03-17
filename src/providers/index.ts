// src/providers/index.ts — Provider registry: id → ProviderDefinition

import type { ProviderDefinition } from '../types.ts'
import { openaiProvider } from './openai.ts'
import { openrouterProvider } from './openrouter.ts'
import { copilotProvider } from './copilot.ts'

const BUILT_IN_PROVIDERS: ProviderDefinition[] = [
  openaiProvider,
  openrouterProvider,
  copilotProvider,
]

export class ProviderRegistry {
  private providers = new Map<string, ProviderDefinition>()

  constructor() {
    for (const p of BUILT_IN_PROVIDERS) {
      this.providers.set(p.id, p)
    }
  }

  get(id: string): ProviderDefinition | null {
    return this.providers.get(id) ?? null
  }

  list(): ProviderDefinition[] {
    return Array.from(this.providers.values())
  }
}
