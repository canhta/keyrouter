// src/auth/codex.ts — OpenAI Codex CLI OAuth (PKCE device flow)
//
// Reference: CLIProxyAPI/sdk/auth/codex.go + codex_device.go
//
// PKCE device flow:
//   1. Generate code_verifier (random 32 bytes → base64url)
//   2. Compute code_challenge = SHA-256(verifier) → base64url
//   3. POST /oauth/authorize with PKCE params → get device_code
//   4. Print verification_uri + user_code
//   5. Poll /oauth/token until authorized or expired
//
// Constants confirmed from CLIProxyAPI source:

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
const AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPES = 'openid email profile offline_access'

interface DeviceAuthResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  token_type?: string
  error?: string
  error_description?: string
}

export class CodexOAuth implements OAuthProvider {
  constructor(private credentialStore: CredentialStore) {}

  /** Start PKCE device flow — generates verifier, requests device code, returns immediately */
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)

    const authParams = new URLSearchParams({
      response_type: 'device_code',
      client_id: CLIENT_ID,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    })

    const authResp = await fetch(`${AUTH_URL}?${authParams}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!authResp.ok) {
      throw new OAuthClientError(`Device code request failed: ${authResp.status}`)
    }

    const device: DeviceAuthResponse = await authResp.json() as DeviceAuthResponse
    return {
      deviceCode: device.device_code,
      userCode: device.user_code,
      verificationUri: device.verification_uri_complete ?? device.verification_uri,
      expiresIn: device.expires_in,
      interval: device.interval,
      codeVerifier,  // stored by dashboard-api for subsequent pollOnce calls
    }
  }

  /** Poll once for authorization result. Caller manages timing/looping. */
  async pollOnce(opts: { deviceCode: string; accountId: string; codeVerifier?: string }): Promise<DevicePollResult> {
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: opts.deviceCode,
        client_id: CLIENT_ID,
        code_verifier: opts.codeVerifier,
      }),
    })

    const token: TokenResponse = await tokenResp.json() as TokenResponse

    if (token.error === 'authorization_pending') return { status: 'pending' }
    if (token.error === 'slow_down') return { status: 'slow_down' }
    if (token.error === 'expired_token') return { status: 'expired' }
    if (token.error === 'access_denied') throw new OAuthClientError('Access denied by user')
    if (token.error) throw new OAuthClientError(`Auth error: ${token.error} — ${token.error_description}`)

    if (token.access_token) {
      const cred: Credential = {
        providerId: 'codex',
        accountId: opts.accountId,
        type: 'oauth',
        value: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      }
      await this.credentialStore.save(cred)
      return { status: 'success', credential: cred }
    }

    return { status: 'pending' }
  }

  /** CLI entry point — full device flow loop */
  async fetchToken(accountId: string): Promise<Credential> {
    const device = await this.startDeviceFlow()

    console.log(`
┌─────────────────────────────────────────────────────────┐
│  OpenAI Codex Authentication                            │
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
      const result = await this.pollOnce({
        deviceCode: device.deviceCode,
        accountId,
        codeVerifier: device.codeVerifier,
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

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: cred.refreshToken,
      }),
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
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return base64urlEncode(bytes)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return base64urlEncode(new Uint8Array(digest))
}

function base64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
