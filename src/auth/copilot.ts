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
  type DeviceFlowStart,
  type DevicePollResult,
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

  /** Start device flow — returns immediately with codes to show user */
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const resp = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
    })

    if (!resp.ok) {
      throw new OAuthClientError(`Device code request failed: ${resp.status}`)
    }

    const device: DeviceCodeResponse = await resp.json() as DeviceCodeResponse
    return {
      deviceCode: device.device_code,
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresIn: device.expires_in,
      interval: device.interval,
    }
  }

  /** Poll once for authorization result. Caller manages timing/looping. */
  async pollOnce(opts: { deviceCode: string; accountId: string }): Promise<DevicePollResult> {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: opts.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    const token: TokenResponse = await resp.json() as TokenResponse

    if (token.error === 'authorization_pending') return { status: 'pending' }
    if (token.error === 'slow_down') return { status: 'slow_down' }
    if (token.error === 'expired_token') return { status: 'expired' }
    if (token.error) throw new OAuthClientError(`Auth error: ${token.error} — ${token.error_description}`)

    if (token.access_token) {
      const copilotToken = await this.exchangeForCopilotToken(token.access_token)
      const cred: Credential = {
        providerId: 'copilot',
        accountId: opts.accountId,
        type: 'oauth',
        value: copilotToken.token,
        refreshToken: token.refresh_token,
        expiresAt: copilotToken.expiresAt,
      }
      await this.credentialStore.save(cred)
      return { status: 'success', credential: cred }
    }

    return { status: 'pending' }
  }

  /** CLI entry point — full device flow loop (shows user_code, polls to completion) */
  async fetchToken(accountId: string): Promise<Credential> {
    const device = await this.startDeviceFlow()

    console.log(`
┌─────────────────────────────────────────────────────────┐
│  GitHub Copilot Authentication                          │
│                                                         │
│  1. Visit: ${device.verificationUri.padEnd(45)}│
│  2. Enter code: ${device.userCode.padEnd(41)}│
│                                                         │
│  Waiting for authorization...                           │
└─────────────────────────────────────────────────────────┘
`)

    let intervalMs = device.interval * 1000
    const deadline = Date.now() + device.expiresIn * 1000

    while (Date.now() < deadline) {
      await sleep(intervalMs)
      const result = await this.pollOnce({ deviceCode: device.deviceCode, accountId })

      if (result.status === 'pending') continue
      if (result.status === 'slow_down') { intervalMs += 5000; continue }
      if (result.status === 'expired') throw new DeviceCodeExpiredError()
      if (result.status === 'success') return result.credential
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
