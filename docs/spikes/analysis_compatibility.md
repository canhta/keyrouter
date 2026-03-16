---
name: Compatibility root cause analysis
description: Cross-project comparison and root causes of incompatibility between 9router, OpenCode, and standard AI routers
type: project
---

## Cross-Project Comparison

| Dimension | 9router | OpenCode (client) | Portkey |
|---|---|---|---|
| Role | Router/proxy | Consumer | Router/proxy |
| Auth | OAuth + API key | Configured by user | API key only |
| Sub-backed providers | Copilot, Codex, Claude Code, Kiro, Gemini CLI | Depends on config | None |
| Endpoints | chat/completions, responses, messages | Calls both | Full OpenAI surface |
| Multi-turn state | Stateless (client sends history) | Sends full history | Stateless |
| Format translation | 8 formats bidirectional | Outputs to provider | 75 providers |
| Fallback/rotation | Per-model lock + account fallback | N/A | Declarative targets |
| Framework | Next.js + Express | — | Hono |
| Storage | SQLite | None | Redis (optional) |

## Root Cause Analysis of Each Hypothesis

### H1: Stateless = single-turn → CONFIRMED FALSE
Router is stateless, but OpenCode always sends full `messages[]`. HTTP multi-turn works fine. "Single-turn feeling" comes from something else.

### H2: Adapter/endpoint mismatch → CONFIRMED — highest risk
- `@ai-sdk/openai-compatible` → ONLY calls `/v1/chat/completions` (safe for custom routers)
- `@ai-sdk/openai` → calls `/v1/responses` for gpt-5+ models
- If router exposes `/v1/responses` but translates to chat/completions internally, structured tool events are lost
- If router doesn't expose `/v1/responses` at all and client uses `@ai-sdk/openai`, requests fail with 404

**Fix:** Configure OpenCode with `@ai-sdk/openai-compatible` for custom router — avoids `/v1/responses` entirely.

### H3: Partial compatibility → CONFIRMED for tool calls
- 9router's `fixMissingToolResponses()` and ID generation suggests tool call ID mismatch has been a real issue
- Tool call ID in assistant `tool_calls[].id` on turn N MUST match `tool_call_id` in tool message on turn N+1
- If router rewrites IDs on inbound (9router does: `call_{timestamp}_{random}`), the ID in the full history OpenCode resends on turn N+1 will be the rewritten ID — this is consistent only if the router rewrites consistently

**Fix for new router:** Never rewrite tool call IDs. Pass them verbatim.

### H4: Streaming format mismatch → INFERRED — medium risk
- OpenCode requests `stream_options: { include_usage: true }`
- Some providers (Copilot) don't return usage in stream
- Vercel AI SDK v5 may throw on missing usage
- `reasoning_opaque` stripping causes silent degradation on multi-turn Copilot

**Fix:** Synthesize usage chunk before `[DONE]` if upstream doesn't provide one. Never strip unknown fields.

### H5: OAuth/subscription auth mode mismatch → CONFIRMED
- GitHub Copilot requires OAuth bearer token — not a regular API key
- Codex uses OAuth device flow — not a regular API key
- Any router that treats `Authorization: Bearer <incoming-key>` as the upstream credential will fail
- The router must obtain and refresh its own OAuth credentials for these providers

## The Real "Single-Turn" Root Cause
Not single-turn at HTTP level. The feeling comes from one of:
1. **Tool call IDs rewritten** → multi-turn tool conversations break on turn 2+
2. **`reasoning_opaque` stripped** → multi-turn reasoning for Copilot resets each turn
3. **`/v1/responses` vs `/v1/chat/completions` mismatch** → wrong endpoint, wrong format, silent failure
4. **Usage chunk missing** → Vercel AI SDK throws, conversation appears to end
5. **Model not actually multi-turn capable** via the selected auth/endpoint combination
