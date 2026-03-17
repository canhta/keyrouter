// src/registry/index.ts — ModelRegistry: lookup + hot-swap
//
// Thread-safe atomic config swap via reference replacement.
// fs.watch callback calls swap() with new config; all in-flight requests
// continue using the old ref, new requests pick up the new one.

import type { ModelEntry, RouterConfig, AccountEntry } from '../types.ts'

export class ModelRegistry {
  private models: Map<string, ModelEntry> = new Map()

  constructor(config: RouterConfig) {
    this.loadModels(config)
  }

  /** Look up a model by client-facing ID. Returns null if not configured. */
  lookup(modelId: string): ModelEntry | null {
    return this.models.get(modelId) ?? null
  }

  /** Return all configured models (for GET /v1/models). */
  list(): ModelEntry[] {
    return Array.from(this.models.values())
  }

  /** Atomically replace model config on hot-reload. */
  swap(config: RouterConfig): void {
    const newModels = new Map<string, ModelEntry>()
    this.buildModels(config, newModels)
    this.models = newModels  // atomic reference swap
  }

  private loadModels(config: RouterConfig): void {
    this.buildModels(config, this.models)
  }

  private buildModels(config: RouterConfig, target: Map<string, ModelEntry>): void {
    target.clear()
    for (const [modelId, modelConf] of Object.entries(config.models ?? {})) {
      const accounts: AccountEntry[] = (modelConf.accounts ?? []).map(a => ({
        id: a.id,
        providerId: a.provider,
      }))
      target.set(modelId, {
        id: modelId,
        upstreamId: modelConf.upstreamId ?? modelId,
        accounts,
      })
    }
  }
}
