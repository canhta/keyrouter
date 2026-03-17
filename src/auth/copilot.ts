// src/auth/copilot.ts — GitHub Copilot OAuth device flow + refresh
//
// Reference: 9router/src/sse/services/auth.js
//
// Device flow:
//   1. POST device code endpoint → get device_code, user_code, verification_uri
//   2. Print user_code + verification_uri to console
//   3. Poll token endpoint every interval seconds until:
//      - success → store + return Credential
//      - authorization_pending → continue
//      - slow_down → increase interval by 5s
//      - expired_token → throw DeviceCodeExpiredError
//      - access_denied → throw OAuthClientError

import {
  type Credential,
  type OAuthProvider,
  type CredentialStore,
  DeviceCodeExpiredError,
  OAuthClientError,
  OAuthRevokedError,
} from '../types.ts'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const CLIENT_ID = 'Iv1.b507a08c87ecfe98'  // GitHub Copilot CLI client ID (from 9router)
const SCOPE = 'read:user'

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

export class CopilotOAuth implements OAuthProvider {
  constructor(private credentialStore: CredentialStore) {}

  async fetchToken(accountId: string): Promise<Credential> {
    // Step 1: Request device code
    const deviceResp = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
    })

    if (!deviceResp.ok) {
      throw new OAuthClientError(`Device code request failed: ${deviceResp.status}`)
    }

    const device: DeviceCodeResponse = await deviceResp.json() as DeviceCodeResponse

    // Step 2: Show instructions to user
    console.log(`
┌─────────────────────────────────────────────────────────┐
│  GitHub Copilot Authentication                          │
│                                                         │
│  1. Visit: ${device.verification_uri.padEnd(45)}│
│  2. Enter code: ${device.user_code.padEnd(41)}│
│                                                         │
│  Waiting for authorization...                           │
└─────────────────────────────────────────────────────────┘
`)

    // Step 3: Poll for token
    let pollInterval = device.interval * 1000
    const deadline = Date.now() + device.expires_in * 1000

    while (Date.now() < deadline) {
      await sleep(pollInterval)

      const tokenResp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })

      const token: TokenResponse = await tokenResp.json() as TokenResponse

      if (token.error === 'authorization_pending') {
        continue
      } else if (token.error === 'slow_down') {
        pollInterval += 5000
        continue
      } else if (token.error === 'expired_token') {
        throw new DeviceCodeExpiredError()
      } else if (token.error === 'access_denied') {
        throw new OAuthClientError('Access denied by user')
      } else if (token.error) {
        throw new OAuthClientError(`Auth error: ${token.error} — ${token.error_description}`)
      } else if (token.access_token) {
        // Success! Build credential with Copilot API token
        const copilotToken = await this.exchangeForCopilotToken(token.access_token)

        const cred: Credential = {
          providerId: 'copilot',
          accountId,
          type: 'oauth',
          value: copilotToken.token,
          refreshToken: token.refresh_token,
          expiresAt: copilotToken.expiresAt,
        }

        await this.credentialStore.save(cred)
        return cred
      }
    }

    throw new DeviceCodeExpiredError()
  }

  async refreshToken(cred: Credential): Promise<Credential> {
    if (!cred.refreshToken) {
      throw new OAuthRevokedError(cred.providerId, cred.accountId)
    }

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        refresh_token: cred.refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (resp.status === 401) {
      throw new OAuthRevokedError(cred.providerId, cred.accountId)
    }

    const token: TokenResponse = await resp.json() as TokenResponse

    if (token.error || !token.access_token) {
      throw new OAuthRevokedError(cred.providerId, cred.accountId)
    }

    const copilotToken = await this.exchangeForCopilotToken(token.access_token)

    const refreshed: Credential = {
      ...cred,
      value: copilotToken.token,
      refreshToken: token.refresh_token ?? cred.refreshToken,
      expiresAt: copilotToken.expiresAt,
    }

    await this.credentialStore.save(refreshed)
    return refreshed
  }

  /** Exchange GitHub OAuth token for Copilot API access token. */
  private async exchangeForCopilotToken(githubToken: string): Promise<{ token: string; expiresAt: number }> {
    const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Editor-Version': 'Neovim/0.9.5',
        'Editor-Plugin-Version': 'copilot.vim/1.16.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
    })

    if (!resp.ok) {
      throw new OAuthClientError(`Failed to get Copilot token: ${resp.status}`)
    }

    const data = await resp.json() as { token: string; expires_at: string }
    const expiresAt = new Date(data.expires_at).getTime()

    return { token: data.token, expiresAt }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
