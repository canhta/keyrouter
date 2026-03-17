// src/handlers/models.ts — GET /v1/models

import type { Context } from 'hono'
import type { ModelRegistry } from '../registry/index.ts'

export function createModelsHandler(registry: ModelRegistry) {
  return (c: Context) => {
    const models = registry.list()
    return c.json({
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: 1677610602,
        owned_by: 'keyrouter',
      })),
    })
  }
}
