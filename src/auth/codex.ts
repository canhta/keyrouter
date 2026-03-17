// src/auth/codex.ts — OpenAI Codex CLI OAuth (device code flow)
//
// Reference: codex-rs/login/src/device_code_auth.rs + server.rs
//
// Device code flow:
//   1. POST /api/accounts/deviceauth/usercode { client_id } → { device_auth_id, user_code, interval }
//   2. User visits https://auth.openai.com/codex/device and enters user_code
//   3. Poll POST /api/accounts/deviceauth/token { device_auth_id, user_code }
//      until 200 → { authorization_code, code_challenge, code_verifier }
//   4. POST /oauth/token (form-urlencoded) with grant_type=authorization_code + PKCE
//      → { id_token, access_token, refresh_token }

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

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const BASE_URL = 'https://auth.openai.com'
const USERCODE_URL = `${BASE_URL}/api/accounts/deviceauth/usercode`
const TOKEN_POLL_URL = `${BASE_URL}/api/accounts/deviceauth/token`
const TOKEN_EXCHANGE_URL = `${BASE_URL}/oauth/token`
const REDIRECT_URI = `${BASE_URL}/deviceauth/callback`
const VERIFICATION_URI = `${BASE_URL}/codex/device`
const DEVICE_CODE_EXPIRES_IN = 900  // 15 minutes

interface UsercodeResponse {
  device_auth_id: string
  user_code: string
  interval: string | number
}

interface CodeSuccessResponse {
  authorization_code: string
  code_challenge: string
  code_verifier: string
}

interface TokenResponse {
  id_token?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

export class CodexOAuth implements OAuthProvider {
  constructor(private credentialStore: CredentialStore) {}

  /** Start device code flow — POST to /deviceauth/usercode, return codes immediately */
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const resp = await fetch(USERCODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    })

    if (!resp.ok) {
      throw new OAuthClientError(`Device code request failed: ${resp.status}`)
    }

    const data: UsercodeResponse = await resp.json() as UsercodeResponse
    const interval = typeof data.interval === 'string'
      ? parseInt(data.interval, 10)
      : (data.interval ?? 5)

    return {
      deviceCode: data.device_auth_id,
      userCode: data.user_code,
      verificationUri: VERIFICATION_URI,
      expiresIn: DEVICE_CODE_EXPIRES_IN,
      interval,
    }
  }

  /** Poll once. On success, exchanges authorization_code for access token and saves credential. */
  async pollOnce(opts: { deviceCode: string; userCode?: string; accountId: string }): Promise<DevicePollResult> {
    const resp = await fetch(TOKEN_POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: opts.deviceCode,
        user_code: opts.userCode ?? '',
      }),
    })

    // Still pending (403 = not yet authorized, 404 = polling too fast)
    if (resp.status === 403 || resp.status === 404) {
      return { status: 'pending' }
    }

    if (!resp.ok) {
      throw new OAuthClientError(`Poll failed with status ${resp.status}`)
    }

    const code: CodeSuccessResponse = await resp.json() as CodeSuccessResponse

    // Exchange authorization_code for tokens
    const tokens = await this.exchangeCode(code.authorization_code, code.code_verifier)

    const cred: Credential = {
      providerId: 'codex',
      accountId: opts.accountId,
      type: 'oauth',
      value: tokens.access_token!,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    }

    await this.credentialStore.save(cred)
    return { status: 'success', credential: cred }
  }

  /** CLI entry point — full device flow loop */
  async fetchToken(accountId: string): Promise<Credential> {
    const device = await this.startDeviceFlow()

    console.log(`
┌─────────────────────────────────────────────────────────┐
│  OpenAI Codex Authentication                            │
│                                                         │
│  1. Visit: ${VERIFICATION_URI.padEnd(45)}│
│  2. Enter code: ${device.userCode.padEnd(41)}│
│                                                         │
│  Waiting for authorization...                           │
└─────────────────────────────────────────────────────────┘
`)

    let intervalMs = device.interval * 1000
    const deadline = Date.now() + DEVICE_CODE_EXPIRES_IN * 1000

    while (Date.now() < deadline) {
      await sleep(intervalMs)
      const result = await this.pollOnce({
        deviceCode: device.deviceCode,
        userCode: device.userCode,
        accountId,
      })

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

    const resp = await fetch(TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: cred.refreshToken,
      }).toString(),
    })

    if (resp.status === 401) {
      throw new OAuthRevokedError(cred.providerId, cred.accountId)
    }

    const token: TokenResponse = await resp.json() as TokenResponse

    if (token.error || !token.access_token) {
      throw new OAuthRevokedError(cred.providerId, cred.accountId)
    }

    const expiresAt = token.expires_in
      ? Date.now() + token.expires_in * 1000
      : cred.expiresAt

    const refreshed: Credential = {
      ...cred,
      value: token.access_token,
      refreshToken: token.refresh_token ?? cred.refreshToken,
      expiresAt,
    }

    await this.credentialStore.save(refreshed)
    return refreshed
  }

  private async exchangeCode(authorizationCode: string, codeVerifier: string): Promise<TokenResponse> {
    const resp = await fetch(TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
    })

    if (!resp.ok) {
      const body = await resp.text()
      throw new OAuthClientError(`Token exchange failed (${resp.status}): ${body}`)
    }

    return resp.json() as Promise<TokenResponse>
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
