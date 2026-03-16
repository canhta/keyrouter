---
name: OpenCode source findings
description: Confirmed behavior from local opencode codebase — SDK usage, endpoint selection, multi-turn handling, streaming format, custom provider config
type: project
---

Source: `/Users/canh/Projects/OSS/routers/opencode` — confirmed from code.

## SDK Stack (confirmed from package.json)
- `ai@5.0.124` — Vercel AI SDK v5
- `@ai-sdk/openai@2.0.89` — OpenAI provider with /v1/responses support
- `@ai-sdk/openai-compatible@1.0.32` — Generic fallback for custom providers
- Custom in-house: `@ai-sdk/github-copilot` (in `src/provider/sdk/copilot/`)

## Critical: Dual Endpoint Routing (confirmed from `provider.ts` lines 55–59)

```typescript
function shouldUseCopilotResponsesApi(modelID: string): boolean {
  const match = /^gpt-(\d+)/.exec(modelID)
  if (!match) return false
  return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
}
```

- Models `gpt-5+` (excluding `gpt-5-mini`) → `POST /v1/responses`
- Everything else → `POST /v1/chat/completions`
- This logic is **Copilot-SDK-specific** — does NOT apply to `@ai-sdk/openai-compatible`
- If router is configured via `@ai-sdk/openai-compatible`, OpenCode ONLY calls `/v1/chat/completions`

## Multi-Turn: Full History Always Resent (confirmed from code)
- Every request includes complete `messages[]` from turn 1
- No windowing, no deduplication
- Router statelessness is expected and correct, not a bug

## Streaming Format (confirmed)
- Standard SSE: `data: {...}\n\n` → `data: [DONE]\n\n`
- Always sends: `stream_options: { include_usage: true }`
- Expects usage object in final chunk before `[DONE]`
- If usage is missing, Vercel AI SDK v5 may throw

## Tool Calling (confirmed)
- Standard OpenAI format: `type: "function"`, `function.parameters` as JSON Schema
- Tool results: `role: "tool"`, `tool_call_id` must match
- If tool_call IDs are rewritten by the router, multi-turn tool conversations break silently

## Critical: reasoning_opaque Field (confirmed)
- Copilot assistant messages carry `reasoning_opaque` and `reasoning_text`
- These are included in full history on every resend
- If the router strips unknown fields, multi-turn reasoning for Copilot loses state silently
- Router MUST use passthrough for all unknown message fields

## Custom Provider Config (confirmed from `src/config/config.ts`)

```jsonc
// opencode.json
{
  "provider": {
    "my-router": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:3000/v1",
        "apiKey": "local-key"
      },
      "models": { ... }
    }
  }
}
```

Config loading order (highest to lowest precedence):
1. Managed/enterprise config
2. Remote .well-known
3. `~/.config/opencode/opencode.json`
4. `OPENCODE_CONFIG` env var
5. `./opencode.json` in project root
6. `./.opencode/opencode.json`
7. `OPENCODE_CONFIG_CONTENT` env var (JSON string)

## Recommended Client Config for Custom Router
Use `@ai-sdk/openai-compatible` in opencode.json — this routes ONLY to `/v1/chat/completions` and avoids any `/v1/responses` complexity until explicitly needed.
