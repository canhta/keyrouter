// src/translation/openai-responses.ts — Responses API ↔ Chat Completions translator
//
// The Responses API (/v1/responses) uses a different schema than Chat Completions.
// This translator converts between them for Codex/gpt-5+ compatibility.
//
// Input conversion (Responses → Chat Completions):
//   input[]     → messages[]
//   input items: "message" → {role, content}
//   input items: "function_call_output" → {role:"tool", content, tool_call_id}
//
// Output conversion (Chat Completions → Responses):
//   Non-streaming: wrap in response.output[] format
//   Streaming: convert SSE chunks to response.delta events
//
// Unsupported event types → 501 Not Implemented:
//   web_search_call, code_interpreter_call, computer_use_call

export interface ResponsesRequest {
  model: string
  input: ResponsesInputItem[]
  instructions?: string
  stream?: boolean
  [key: string]: unknown
}

export type ResponsesInputItem =
  | { type: 'message'; role: string; content: string | ResponsesContent[] }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: string; [key: string]: unknown }

export interface ResponsesContent {
  type: 'input_text' | 'input_image' | string
  text?: string
  [key: string]: unknown
}

interface ChatMessage {
  role: string
  content: string | null
  tool_call_id?: string
  [key: string]: unknown
}

/** Convert a Responses API input array to Chat Completions messages array. */
export function inputToMessages(
  input: ResponsesInputItem[],
  instructions?: string
): ChatMessage[] {
  const messages: ChatMessage[] = []

  // System instruction becomes a system message
  if (instructions) {
    messages.push({ role: 'system', content: instructions })
  }

  for (const item of input) {
    if (item.type === 'message') {
      const content = Array.isArray(item.content)
        ? item.content.map(c => (c.type === 'input_text' ? c.text ?? '' : '')).join('')
        : (item.content as string)
      messages.push({ role: item.role as string, content })
    } else if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        content: item.output as string,
        tool_call_id: item.call_id as string,
      })
    }
    // Other types (web_search_result, etc.) are silently skipped for now
  }

  return messages
}

/** Check if a Responses API request contains unsupported tool types.
 *  Returns the unsupported type name or null. */
export function findUnsupportedType(input: ResponsesInputItem[]): string | null {
  const unsupported = ['web_search_call', 'code_interpreter_call', 'computer_use_call']
  for (const item of input) {
    if (unsupported.includes(item.type)) return item.type
  }
  return null
}

/** Wrap a Chat Completions response into Responses API format. */
export function wrapChatResponse(chatResponse: Record<string, unknown>): Record<string, unknown> {
  const choices = chatResponse['choices'] as Array<{
    message: { role: string; content: string | null; tool_calls?: unknown[] }
    finish_reason: string
  }>

  const output = (choices ?? []).map(choice => {
    const msg = choice.message
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        type: 'function_call',
        call_id: (msg.tool_calls[0] as { id: string }).id,
        name: ((msg.tool_calls[0] as { function: { name: string } }).function).name,
        arguments: ((msg.tool_calls[0] as { function: { arguments: string } }).function).arguments,
      }
    }
    return {
      type: 'message',
      role: msg.role,
      content: [{ type: 'output_text', text: msg.content ?? '' }],
    }
  })

  return {
    id: chatResponse['id'],
    object: 'response',
    created_at: chatResponse['created'],
    model: chatResponse['model'],
    output,
    usage: chatResponse['usage'],
    status: 'completed',
  }
}
