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

  async fetchToken(accountId: string): Promise<Credential> {
    // Step 1: Generate PKCE code verifier + challenge
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)

    // Step 2: Request device code via authorization endpoint
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

    // Step 3: Show instructions
    console.log(`
┌─────────────────────────────────────────────────────────┐
│  OpenAI Codex Authentication                            │
│                                                         │
│  1. Visit: ${device.verification_uri.padEnd(45)}│
│  2. Enter code: ${device.user_code.padEnd(41)}│
│                                                         │
│  Waiting for authorization...                           │
└─────────────────────────────────────────────────────────┘
`)

    // Step 4: Poll for token
    let pollInterval = device.interval * 1000
    const deadline = Date.now() + device.expires_in * 1000

    while (Date.now() < deadline) {
      await sleep(pollInterval)

      const tokenResp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
          client_id: CLIENT_ID,
          code_verifier: codeVerifier,
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
        const expiresAt = token.expires_in
          ? Date.now() + token.expires_in * 1000
          : undefined

        const cred: Credential = {
          providerId: 'codex',
          accountId,
          type: 'oauth',
          value: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt,
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
