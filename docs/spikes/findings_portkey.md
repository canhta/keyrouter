---
name: Portkey source findings
description: Confirmed architecture details from local portkey codebase — provider abstraction, fallback, streaming, tool calls, virtual keys
type: project
---

Source: `/Users/canh/Projects/OSS/routers/portkey` — confirmed from code.

## Stack
- Hono v4.9.7 (~122kb) — multi-runtime: Node.js, Cloudflare Workers
- `@hono/node-server`, `@hono/node-ws` for Node.js
- `async-retry` for exponential backoff
- `ioredis` for optional caching
- `@smithy/signature-v4` for AWS SigV4
- `zod` for schema validation
- Default port: 8787

## Endpoints (confirmed from `src/index.ts`)
```
POST /v1/chat/completions
POST /v1/completions
POST /v1/embeddings
POST /v1/images/generations
POST /v1/audio/speech
POST /v1/audio/transcriptions
GET  /v1/models
GET/POST /v1/messages        (Anthropic format)
POST /v1/responses           (+ GET, DELETE /:id)
Files API, Batches API
GET  /v1/realtime            (WebSocket, Node.js only)
```

## Provider Abstraction Pattern (confirmed from `src/providers/`)
75+ providers, each implementing:
```typescript
interface ProviderAPIConfig {
  headers(opts): Promise<Record<string, string>>
  getBaseURL(opts): string
  getEndpoint(endpointType): string
}
// + requestTransformer: OpenAI → ProviderFormat
// + responseTransformer: ProviderFormat → OpenAI
// + streamTransformer: ProviderStreamChunk → SSE chunk
```

## Fallback Logic (confirmed from `src/handlers/handlerUtils.ts`)
- `tryTargetsRecursively()` with circuit breaker
- Retries on: 429, 500, 502, 503, 504
- Respects `retry-after`, `retry-after-ms`, `x-ms-retry-after-ms` headers
- Max retry timeout: 60s
- Declarative via `x-portkey-config` header (JSON)

## Virtual Keys (confirmed)
- Header: `x-portkey-virtual-key: <key_name>`
- Maps to actual provider credentials stored in config
- Budget enforcement via `PreRequestValidatorService`

## Streaming Normalization (confirmed from `src/handlers/streamHandler.ts`)
- `readStream()` — generic SSE with per-provider split pattern + transform function
- `readAWSStream()` — binary length-prefixed chunks for Bedrock
- JSON-streaming providers (Google, Cohere) converted to SSE format
- Cache-hit JSON responses can be re-streamed via `OpenAIChatCompleteJSONToStreamResponseTransform`

## Tool Call Handling (confirmed)
- OpenAI → Anthropic: `tools[]` with `input_schema`, `tool_choice` mapping
- Tool results: normalized to OpenAI format on output
- `function_call` (deprecated) still supported, mapped to `tool_choice`

## Auth: Incoming vs Outgoing
- Incoming: `Authorization: Bearer`, or `x-portkey-config` JSON, or `x-portkey-provider` + `x-portkey-api-key`
- Outgoing: per-provider `headers()` function builds auth
- SSRF protection: blocks cloud metadata endpoints (169.254.169.254, etc.)
- AWS: SigV4 signing, role assumption via `awsRoleArn`

## What Portkey Does NOT Support
- Subscription-backed OAuth providers (Copilot, Codex) — API key only
- This is the key gap that 9router fills

## Key Architectural Insights for New Router
- Use Portkey's per-provider transformer pattern (request + response + stream)
- Use Portkey's `tryTargetsRecursively` fallback model
- Do NOT adopt its virtual key complexity for MVP
- Hono is an excellent framework choice: lightweight, multi-runtime, fast
