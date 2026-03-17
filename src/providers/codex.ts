// src/providers/codex.ts — OpenAI Codex provider (OAuth)

import type { Credential, ProviderDefinition } from '../types.ts'

export const codexProvider: ProviderDefinition = {
  id: 'codex',
  name: 'OpenAI Codex',
  baseUrl: 'https://api.openai.com',
  requestHeaders(cred: Credential): Record<string, string> {
    return {
      'Authorization': `Bearer ${cred.value}`,
      'Content-Type': 'application/json',
    }
  },
}
