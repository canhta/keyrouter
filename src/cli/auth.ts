// src/cli/auth.ts — runAuthFlow: orchestrate device flow + store token

import { openDatabase } from '../db/migrations.ts'
import { loadConfig } from '../config.ts'
import { SqliteCredentialStore } from '../auth/store.ts'
import { CopilotOAuth } from '../auth/copilot.ts'

const SUPPORTED_PROVIDERS = ['copilot'] as const
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export async function runAuthFlow(provider: string | undefined): Promise<void> {
  if (!provider) {
    console.error('[keyrouter] Usage: keyrouter auth <provider>')
    console.error('  Supported providers: ' + SUPPORTED_PROVIDERS.join(', '))
    process.exit(1)
  }

  if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    console.error(`[keyrouter] Unknown provider: ${provider}`)
    console.error('  Supported providers: ' + SUPPORTED_PROVIDERS.join(', '))
    process.exit(1)
  }

  const config = loadConfig()
  const db = openDatabase()
  const credentialStore = new SqliteCredentialStore(db)

  if (provider === 'copilot') {
    const copilot = new CopilotOAuth(credentialStore)
    const accountId = 'default'

    console.log(`[keyrouter] Starting Copilot OAuth device flow for account: ${accountId}`)

    try {
      const cred = await copilot.fetchToken(accountId)
      console.log(`\n[keyrouter] ✓ Copilot authentication successful!`)
      console.log(`  Account: ${cred.accountId}`)
      if (cred.expiresAt) {
        const expiresIn = Math.round((cred.expiresAt - Date.now()) / 1000 / 60)
        console.log(`  Token expires in: ~${expiresIn} minutes`)
      }
      console.log(`\nYou can now start keyrouter with: keyrouter\n`)
    } catch (err) {
      console.error(`[keyrouter] Auth failed: ${(err as Error).message}`)
      process.exit(1)
    }
  }
}
