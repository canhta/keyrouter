// src/translation/stream.ts — UsageSynthesisTransform
//
// SSE pipeline:
//
//   upstream bytes
//       │
//       ▼
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  Line splitter (handles \r\n and \n)                           │
//   │                                                                 │
//   │  for each line:                                                 │
//   │  ┌───────────────────────────────────────────────────────────┐  │
//   │  │ "data: {...}" → JSON.parse (try/catch: skip bad lines)    │  │
//   │  │ if chunk has usage → state.usageEmitted = true            │  │
//   │  │ yield line as-is                                          │  │
//   │  └───────────────────────────────────────────────────────────┘  │
//   │                                                                 │
//   │  on "data: [DONE]":                                             │
//   │  ┌───────────────────────────────────────────────────────────┐  │
//   │  │ if !state.usageEmitted → yield synthetic usage chunk      │  │
//   │  │ yield "data: [DONE]\n\n"                                  │  │
//   │  │ usageStore.record(record).catch(warn)  // fire-and-forget  │  │
//   │  │ routing.onSuccess(accountId, modelId)                     │  │
//   │  └───────────────────────────────────────────────────────────┘  │
//   └─────────────────────────────────────────────────────────────────┘
//       │
//       ▼
//   client bytes

import type { UsageRecord } from '../types.ts'

export interface UsageSynthesisOptions {
  modelId: string
  accountId: string
  providerId: string
  startTime: number
  onComplete: (record: Partial<UsageRecord>) => void
  onError?: (err: Error) => void
}

/**
 * Creates a TransformStream that:
 * 1. Passes through all SSE bytes
 * 2. Detects usage chunks from the provider
 * 3. Synthesizes a usage chunk before [DONE] if none was emitted
 * 4. Calls onComplete with token counts when stream ends
 */
export function createUsageSynthesisStream(
  opts: UsageSynthesisOptions
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  let buffer = ''
  let usageEmitted = false
  let promptTokens = 0
  let completionTokens = 0

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })

      // Split on newlines, keeping any incomplete line in the buffer
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''  // last element may be incomplete

      for (const line of lines) {
        const trimmed = line.trimEnd()

        if (trimmed === 'data: [DONE]') {
          // Inject synthetic usage chunk if none was emitted
          if (!usageEmitted && completionTokens > 0) {
            const synthetic = buildSyntheticUsageChunk(
              promptTokens,
              completionTokens
            )
            controller.enqueue(encoder.encode(synthetic))
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          continue
        }

        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6))
            // Track token counts from any chunk
            if (json.usage) {
              usageEmitted = true
              promptTokens = json.usage.prompt_tokens ?? promptTokens
              completionTokens = json.usage.completion_tokens ?? completionTokens
            }
            // Count tokens from delta if no usage chunk
            if (json.choices?.[0]?.delta?.content) {
              // Rough estimate: 1 token ≈ 4 chars
              completionTokens += Math.ceil(json.choices[0].delta.content.length / 4)
            }
          } catch {
            // Malformed chunk — log and skip
            console.warn('[keyrouter] malformed SSE chunk, skipping:', trimmed.slice(0, 100))
          }
        }

        // Always forward the original line
        if (trimmed !== 'data: [DONE]') {
          controller.enqueue(encoder.encode(line + '\n'))
        }
      }
    },

    flush(controller) {
      // Handle any remaining buffer content
      if (buffer.trim()) {
        controller.enqueue(encoder.encode(buffer))
      }

      // Call completion handler
      opts.onComplete({
        modelId: opts.modelId,
        accountId: opts.accountId,
        providerId: opts.providerId,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        durationMs: Date.now() - opts.startTime,
        streamingRequest: true,
      })
    },
  })
}

function buildSyntheticUsageChunk(
  promptTokens: number,
  completionTokens: number
): string {
  const chunk = {
    id: 'synthetic',
    object: 'chat.completion.chunk',
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}
