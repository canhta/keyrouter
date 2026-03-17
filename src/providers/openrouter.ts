// src/providers/openrouter.ts — OpenRouter API key provider

import type { Credential, ProviderDefinition } from '../types.ts'

export const openrouterProvider: ProviderDefinition = {
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai',
  requestHeaders(cred: Credential): Record<string, string> {
    return {
      'Authorization': `Bearer ${cred.value}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/keyrouter/keyrouter',
      'X-Title': 'keyrouter',
    }
  },
}
