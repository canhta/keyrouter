import { describe, it, expect } from 'bun:test'
import { ModelRegistry } from '../../src/registry/index.ts'
import type { RouterConfig } from '../../src/types.ts'

const baseConfig: RouterConfig = {
  models: {
    'gpt-4o': {
      accounts: [{ id: 'copilot-default', provider: 'copilot' }],
    },
    'gpt-4o-mini': {
      upstreamId: 'gpt-4o-mini-2024-07-18',
      accounts: [{ id: 'openai-default', provider: 'openai' }],
    },
  },
}

describe('ModelRegistry', () => {
  describe('lookup()', () => {
    it('returns ModelEntry for a known model', () => {
      const registry = new ModelRegistry(baseConfig)
      const entry = registry.lookup('gpt-4o')
      expect(entry).not.toBeNull()
      expect(entry!.id).toBe('gpt-4o')
      expect(entry!.upstreamId).toBe('gpt-4o')
      expect(entry!.accounts).toHaveLength(1)
      expect(entry!.accounts[0]!.id).toBe('copilot-default')
      expect(entry!.accounts[0]!.providerId).toBe('copilot')
    })

    it('uses upstreamId when specified', () => {
      const registry = new ModelRegistry(baseConfig)
      const entry = registry.lookup('gpt-4o-mini')
      expect(entry!.upstreamId).toBe('gpt-4o-mini-2024-07-18')
    })

    it('returns null for unknown model', () => {
      const registry = new ModelRegistry(baseConfig)
      const entry = registry.lookup('non-existent-model')
      expect(entry).toBeNull()
    })

    it('returns null for empty string', () => {
      const registry = new ModelRegistry(baseConfig)
      expect(registry.lookup('')).toBeNull()
    })
  })

  describe('list()', () => {
    it('returns all configured models', () => {
      const registry = new ModelRegistry(baseConfig)
      const models = registry.list()
      expect(models).toHaveLength(2)
      const ids = models.map(m => m.id)
      expect(ids).toContain('gpt-4o')
      expect(ids).toContain('gpt-4o-mini')
    })

    it('returns empty array when no models configured', () => {
      const registry = new ModelRegistry({ models: {} })
      expect(registry.list()).toHaveLength(0)
    })
  })

  describe('swap()', () => {
    it('atomically replaces model config', () => {
      const registry = new ModelRegistry(baseConfig)
      expect(registry.lookup('gpt-4o')).not.toBeNull()

      const newConfig: RouterConfig = {
        models: {
          'claude-3-5-sonnet': {
            accounts: [{ id: 'openrouter-default', provider: 'openrouter' }],
          },
        },
      }

      registry.swap(newConfig)

      expect(registry.lookup('gpt-4o')).toBeNull()
      expect(registry.lookup('claude-3-5-sonnet')).not.toBeNull()
    })
  })
})
