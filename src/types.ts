// src/types.ts — ALL shared interfaces in one file
// See ARCHITECTURE.md for the full design document.

// ─── Credential & Auth ────────────────────────────────────────────────────────

export type CredentialType = 'api_key' | 'oauth'

export interface Credential {
  providerId: string
  accountId: string
  type: CredentialType
  value: string        // API key or access token
  refreshToken?: string
  expiresAt?: number   // unix ms; undefined = never expires
}

export interface OAuthProvider {
  /** Initiate device/PKCE flow; stores token; returns Credential */
  fetchToken(accountId: string): Promise<Credential>
  /** Refresh using refreshToken; returns updated Credential */
  refreshToken(cred: Credential): Promise<Credential>
}

export interface CredentialStore {
  /** Resolve credential, refreshing if expiring soon (5-min buffer).
   *  Deduplicates concurrent refresh calls per (providerId, accountId). */
  resolve(providerId: string, accountId: string): Promise<Credential>
  /** Persist a credential to SQLite. */
  save(cred: Credential): Promise<void>
  /** Clear a credential (called after OAuthRevokedError). */
  clear(providerId: string, accountId: string): Promise<void>
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface ProviderDefinition {
  id: string
  name: string
  baseUrl: string
  /** Build ALL request headers (auth + capability headers like Editor-Version).
   *  IMPORTANT: Named requestHeaders() not authHeader() — Copilot needs
   *  capability headers beyond just Authorization. */
  requestHeaders(cred: Credential): Record<string, string>
  /** For OAuth providers, implement OAuthProvider. Optional for API-key providers. */
  oauth?: OAuthProvider
}

// ─── Model Registry ───────────────────────────────────────────────────────────

export interface AccountEntry {
  id: string          // e.g. "copilot-work"
  providerId: string  // e.g. "copilot"
}

export interface ModelEntry {
  id: string          // model name as seen by clients
  upstreamId: string  // model name sent to provider (may differ)
  accounts: AccountEntry[]
}

export interface RouterConfig {
  server?: {
    port?: number
    apiKey?: string
  }
  models: {
    [modelId: string]: {
      upstreamId?: string
      accounts: Array<{ id: string; provider: string }>
    }
  }
  providers?: {
    [providerId: string]: {
      apiKey?: string
      baseUrl?: string
    }
  }
}

// ─── Routing ──────────────────────────────────────────────────────────────────

export interface RoutingStrategy {
  /** Returns accounts sorted: unlocked (round-robin) first, locked (by expiry) last.
   *  Returns [] if all accounts are locked. */
  selectAccounts(modelId: string, accounts: AccountEntry[]): AccountEntry[]
  onSuccess(accountId: string, modelId: string): void
  onError(accountId: string, modelId: string, statusCode: number): void
}

// ─── Translation ──────────────────────────────────────────────────────────────

/** CRITICAL: Never destructure this type. Always spread when modifying:
 *   ✓ { ...req, model: resolvedModel }
 *   ✗ const { model, messages, ...rest } = req   ← strips unknown fields (breaks reasoning_opaque)
 */
export interface CanonicalChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  [key: string]: unknown  // MUST forward all unknown fields verbatim
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  [key: string]: unknown  // preserve tool_calls, tool_call_id, etc.
}

export interface StreamState {
  usageEmitted: boolean
  inputTokens: number
  outputTokens: number
  model: string
}

// ─── Usage ────────────────────────────────────────────────────────────────────

export interface UsageRecord {
  id?: number
  timestamp: number        // unix ms
  modelId: string
  providerId: string
  accountId: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  streamingRequest: boolean
}

// ─── Error Classes ────────────────────────────────────────────────────────────

export class OAuthRevokedError extends Error {
  constructor(public providerId: string, public accountId: string) {
    super(`OAuth token revoked for ${providerId}/${accountId}. Run: keyrouter auth ${providerId}`)
    this.name = 'OAuthRevokedError'
  }
}

export class CredentialNotFoundError extends Error {
  constructor(public providerId: string, public accountId: string) {
    super(`No credential found for ${providerId}/${accountId}. Run: keyrouter auth ${providerId}`)
    this.name = 'CredentialNotFoundError'
  }
}

export class DeviceCodeExpiredError extends Error {
  constructor() {
    super('Device code expired. Please try again.')
    this.name = 'DeviceCodeExpiredError'
  }
}

export class OAuthClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthClientError'
  }
}
