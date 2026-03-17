// src/auth/apikey.ts — Static API key credential (no refresh)

import type { Credential, CredentialStore } from '../types.ts'
import type { RouterConfig } from '../types.ts'

/** In-memory API key credential store backed by router.json config. */
export class ApiKeyCredentialStore implements CredentialStore {
  constructor(private config: RouterConfig) {}

  async resolve(providerId: string, accountId: string): Promise<Credential> {
    const providerConf = this.config.providers?.[providerId]
    if (!providerConf?.apiKey) {
      throw new Error(`No API key configured for provider: ${providerId}`)
    }
    return {
      providerId,
      accountId,
      type: 'api_key',
      value: providerConf.apiKey,
    }
  }

  async save(_cred: Credential): Promise<void> {
    // API keys come from config; nothing to persist
  }

  async clear(_providerId: string, _accountId: string): Promise<void> {
    // No-op for API keys
  }
}
