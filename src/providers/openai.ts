// src/providers/openai.ts — OpenAI API key provider

import type { Credential, ProviderDefinition } from '../types.ts'

export const openaiProvider: ProviderDefinition = {
  id: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com',
  requestHeaders(cred: Credential): Record<string, string> {
    return {
      'Authorization': `Bearer ${cred.value}`,
      'Content-Type': 'application/json',
    }
  },
}
