import { describe, it, expect } from 'bun:test'
import {
  inputToMessages,
  findUnsupportedType,
  wrapChatResponse,
} from '../../src/translation/openai-responses.ts'

describe('inputToMessages()', () => {
  it('converts message items to chat messages', () => {
    const messages = inputToMessages([
      { type: 'message', role: 'user', content: 'Hello' },
      { type: 'message', role: 'assistant', content: 'Hi there' },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello' })
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there' })
  })

  it('prepends system message from instructions', () => {
    const messages = inputToMessages(
      [{ type: 'message', role: 'user', content: 'Hi' }],
      'You are a helpful assistant'
    )
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' })
    expect(messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  it('converts function_call_output to tool message', () => {
    const messages = inputToMessages([
      { type: 'function_call_output', call_id: 'call_abc', output: '{"result": 42}' },
    ])
    expect(messages[0]).toEqual({
      role: 'tool',
      content: '{"result": 42}',
      tool_call_id: 'call_abc',
    })
  })

  it('handles content as array of input_text', () => {
    const messages = inputToMessages([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello from array' }],
      },
    ])
    expect(messages[0]!.content).toBe('Hello from array')
  })
})

describe('findUnsupportedType()', () => {
  it('returns null for supported types', () => {
    expect(findUnsupportedType([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call_output', call_id: 'x', output: 'y' },
    ])).toBeNull()
  })

  it('returns type name for web_search_call', () => {
    expect(findUnsupportedType([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'web_search_call' },
    ])).toBe('web_search_call')
  })

  it('returns type name for code_interpreter_call', () => {
    expect(findUnsupportedType([{ type: 'code_interpreter_call' }])).toBe('code_interpreter_call')
  })
})

describe('wrapChatResponse()', () => {
  it('wraps a text response into Responses API format', () => {
    const chatResponse = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1720000000,
      model: 'gpt-4o',
      choices: [
        {
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
          index: 0,
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }

    const result = wrapChatResponse(chatResponse)
    expect(result['id']).toBe('chatcmpl-abc')
    expect(result['object']).toBe('response')
    expect(result['status']).toBe('completed')

    const output = result['output'] as Array<{ type: string; content: Array<{ type: string; text: string }> }>
    expect(output[0]!.type).toBe('message')
    expect(output[0]!.content[0]!.text).toBe('Hello!')
  })
})
