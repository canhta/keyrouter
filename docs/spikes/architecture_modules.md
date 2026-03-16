---
name: Recommended router architecture and modules
description: Module breakdown, TypeScript interfaces, folder structure, and API surface for the lightweight self-hosted router
type: project
---

## Architecture Overview

```
Client (OpenCode / AI SDK)
        │  POST /v1/chat/completions  (or /v1/responses)
        ▼
┌─────────────────────────────────────────┐
│            LocalRouter (Hono)            │
│  1. Auth middleware (incoming API key)  │
│  2. Model → Route resolution            │
│  3. Credential fetch + token refresh    │
│  4. Request translation (in)            │
│  5. Provider call + retry/fallback      │
│  6. Response/stream translation (out)   │
└─────────────────────────────────────────┘
        │  provider-native format
        ▼
┌─────────────┐  ┌──────────────┐  ┌───────────────┐
│  Copilot    │  │  Codex       │  │  API-key       │
│  (OAuth)    │  │  (OAuth)     │  │  providers     │
└─────────────┘  └──────────────┘  └───────────────┘
```

## API Recommendation

**MVP: `/v1/chat/completions` only**
Configure OpenCode with `@ai-sdk/openai-compatible` — this guarantees only `/v1/chat/completions` is ever called.

**Phase 2: Add `/v1/responses`**
Only needed if:
- Using `@ai-sdk/openai` adapter pointing at the router
- Routing to Codex or gpt-5+ models

## Module Map

### `auth/` — Credential & OAuth Layer
```typescript
interface Credential {
  type: 'apiKey' | 'oauthBearer'
  value: string
  expiresAt?: number    // unix ms; undefined = never expires
  refreshToken?: string
}

interface OAuthProvider {
  fetchToken(deviceCode?: string): Promise<Credential>
  refreshToken(credential: Credential): Promise<Credential>
  isExpiringSoon(credential: Credential): boolean  // <5min buffer
}

interface CredentialStore {
  get(providerId: string, accountId: string): Promise<Credential>
  refresh(providerId: string, accountId: string): Promise<Credential>
  store(providerId: string, accountId: string, cred: Credential): Promise<void>
}
```
Implementations: `CopilotOAuth`, `CodexOAuth`, `ApiKeyCredential`

### `providers/` — Provider Abstraction
```typescript
interface ProviderDefinition {
  id: string
  baseURL: string
  authHeader(cred: Credential): Record<string, string>
  endpoint: {
    chatCompletions: string
    responses?: string
  }
}
```

### `registry/` — Model Capability Registry
```typescript
interface ModelEntry {
  modelId: string        // what client sends, e.g. "gpt-4o"
  providerId: string
  accountId?: string
  endpoint: 'chat' | 'responses'
  capabilities: {
    streaming: boolean
    toolCalls: boolean
    vision: boolean
    reasoning: boolean   // if true, preserve reasoning_opaque passthrough
    maxContextTokens: number
  }
}
```

### `translation/` — Request/Response Translation
```typescript
interface Translator {
  toProvider(req: CanonicalRequest, model: ModelEntry): ProviderRequest
  fromProvider(res: ProviderResponse, model: ModelEntry): CanonicalResponse
  fromProviderStream(
    chunk: string,
    model: ModelEntry,
    state: StreamState
  ): CanonicalStreamChunk | null
}

interface StreamState {
  id: string
  model: string
  created: number
  usageEmitted: boolean
}
```
MVP: `OpenAIChatTranslator` = identity passthrough. Add `OpenAIResponsesTranslator` for phase 2.

**CRITICAL:** Never strip unknown fields. Use `[key: string]: unknown` spread everywhere.

### `routing/` — Routing & Fallback
```typescript
interface RoutingStrategy {
  selectAccount(modelId: string, accounts: AccountEntry[]): AccountEntry | null
  onSuccess(accountId: string, modelId: string): void
  onError(accountId: string, modelId: string, statusCode: number): void
  getLockExpiry(accountId: string, modelId: string): number | null
}
```
Backoff sequence: 30s → 1m → 5m → 30m on 429/5xx.

### `usage/` — Usage Tracking
```typescript
interface UsageRecord {
  ts: number
  modelId: string
  providerId: string
  accountId: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  statusCode: number
  error?: string
}
```
SQLite-backed. No Redis needed at MVP.

## Canonical Types

```typescript
interface CanonicalChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  tools?: Tool[]
  tool_choice?: ToolChoice
  temperature?: number
  max_tokens?: number
  stream_options?: { include_usage?: boolean }
  [key: string]: unknown   // MUST passthrough unknown fields
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_text?: string       // Copilot: MUST passthrough
  reasoning_opaque?: string     // Copilot: MUST passthrough — never strip
  [key: string]: unknown
}
```

## Folder Structure

```
local-router/
├── src/
│   ├── index.ts                  # Hono app entry point
│   ├── config.ts                 # Load router.json
│   ├── auth/
│   │   ├── types.ts
│   │   ├── store.ts              # SQLite credential store
│   │   ├── copilot.ts            # Copilot OAuth flow
│   │   ├── codex.ts              # Codex OAuth flow
│   │   └── apikey.ts
│   ├── providers/
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   ├── copilot.ts
│   │   ├── openai.ts
│   │   └── openrouter.ts
│   ├── registry/
│   │   ├── types.ts
│   │   ├── loader.ts
│   │   └── index.ts
│   ├── translation/
│   │   ├── types.ts
│   │   ├── openai-chat.ts        # Passthrough translator (MVP)
│   │   ├── openai-responses.ts   # Responses API translator (phase 2)
│   │   └── stream.ts             # SSE normalization + usage synthesis
│   ├── routing/
│   │   ├── types.ts
│   │   ├── strategy.ts           # Round-robin + backoff
│   │   └── lock-store.ts         # SQLite model lock tracking
│   ├── handlers/
│   │   ├── chat-completions.ts   # POST /v1/chat/completions
│   │   ├── responses.ts          # POST /v1/responses (phase 2)
│   │   └── models.ts             # GET /v1/models
│   └── usage/
│       ├── types.ts
│       └── store.ts
├── router.json                   # Config: models → providers mapping
├── data/router.db                # SQLite: credentials, locks, usage
├── package.json
└── tsconfig.json
```

## router.json Schema

```typescript
interface RouterConfig {
  server: { port: number; apiKey?: string }
  models: ModelConfig[]
  providers: ProviderConfig[]
}

interface ModelConfig {
  id: string              // what clients send
  providerId: string
  accounts: string[]      // try in order
  endpoint: 'chat' | 'responses'
  capabilities: { toolCalls: boolean; streaming: boolean; reasoning: boolean; vision: boolean; maxContextTokens: number }
}

interface ProviderConfig {
  id: string
  type: 'copilot-oauth' | 'codex-oauth' | 'apikey' | 'openai-compatible'
  baseURL: string
  accounts: { id: string; apiKey?: string; clientId?: string }[]
}
```
