import { describe, it, expect, mock } from 'bun:test'
import { createUsageSynthesisStream } from '../../src/translation/stream.ts'

async function processSSE(
  input: string[],
  onComplete = mock(() => {})
): Promise<string> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const synthesisStream = createUsageSynthesisStream({
    modelId: 'gpt-4o',
    accountId: 'test',
    providerId: 'openai',
    startTime: Date.now(),
    onComplete,
  })

  // Build an input ReadableStream from the string array
  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of input) {
        controller.enqueue(encoder.encode(line))
      }
      controller.close()
    },
  })

  // Pipe through the synthesis transform
  const outputStream = inputStream.pipeThrough(synthesisStream)

  // Collect all output
  let output = ''
  for await (const chunk of outputStream as AsyncIterable<Uint8Array>) {
    output += decoder.decode(chunk)
  }

  return output
}

describe('UsageSynthesisTransform', () => {
  it('passes through normal SSE chunks unchanged', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: 'Hello' }, index: 0, finish_reason: null }],
    })

    const input = [
      `data: ${chunk}\n\n`,
      'data: [DONE]\n\n',
    ]

    const output = await processSSE(input)
    expect(output).toContain(chunk)
    expect(output).toContain('data: [DONE]')
  })

  it('synthesizes usage chunk before [DONE] when none provided', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: 'Hello world' }, index: 0, finish_reason: 'stop' }],
    })

    const input = [
      `data: ${chunk}\n\n`,
      'data: [DONE]\n\n',
    ]

    const output = await processSSE(input)
    const lines = output.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')

    // Should have at least 2 chunks: original + synthetic usage
    expect(lines.length).toBeGreaterThanOrEqual(2)

    // Find synthetic usage chunk
    const syntheticLine = lines.find(l => {
      try {
        const json = JSON.parse(l.slice(6))
        return json.usage !== undefined
      } catch {
        return false
      }
    })
    expect(syntheticLine).toBeDefined()

    // [DONE] should come after synthetic usage
    const syntheticIdx = output.indexOf(syntheticLine!)
    const doneIdx = output.indexOf('data: [DONE]')
    expect(syntheticIdx).toBeLessThan(doneIdx)
  })

  it('does NOT synthesize usage chunk when provider already sent one', async () => {
    const contentChunk = JSON.stringify({
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: 'Hi' }, index: 0, finish_reason: null }],
    })

    const usageChunk = JSON.stringify({
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })

    const input = [
      `data: ${contentChunk}\n\n`,
      `data: ${usageChunk}\n\n`,
      'data: [DONE]\n\n',
    ]

    const output = await processSSE(input)

    // Count usage chunks in output
    const lines = output.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
    const usageLines = lines.filter(l => {
      try {
        const json = JSON.parse(l.slice(6))
        return json.usage !== undefined
      } catch {
        return false
      }
    })

    // Should have exactly one usage chunk (the real one, not a synthetic duplicate)
    expect(usageLines.length).toBe(1)
  })

  it('skips malformed SSE chunks and continues stream', async () => {
    const validChunk = JSON.stringify({
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: 'OK' }, index: 0, finish_reason: null }],
    })

    const input = [
      `data: ${validChunk}\n\n`,
      'data: {this is not valid json}\n\n',  // malformed
      'data: [DONE]\n\n',
    ]

    // Should not throw
    const output = await processSSE(input)
    expect(output).toContain(validChunk)
    expect(output).toContain('data: [DONE]')
  })

  it('calls onComplete with usage data', async () => {
    const onComplete = mock(() => {})

    const usageChunk = JSON.stringify({
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })

    await processSSE(
      [`data: ${usageChunk}\n\n`, 'data: [DONE]\n\n'],
      onComplete
    )

    expect(onComplete).toHaveBeenCalledTimes(1)
    const record = (onComplete as ReturnType<typeof mock>).mock.calls[0]![0]
    expect(record.modelId).toBe('gpt-4o')
    expect(record.accountId).toBe('test')
  })
})
