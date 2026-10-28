export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export type ToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type Response = { message: Extract<Message, { role: 'assistant' }>; finishReason: string | null; inputTokens: number; outputTokens: number };
export interface LlmAdapter {
  enviar(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<Response>;
}
