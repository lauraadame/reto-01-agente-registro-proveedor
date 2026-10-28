import Groq from 'groq-sdk';
import type { LlmAdapter, Message, Response, ToolDefinition } from './adapter.js';

export const defaultModel = 'openai/gpt-oss-20b';

export class GroqAdapter implements LlmAdapter {
  private readonly client: Groq;
  constructor(private readonly model = process.env.MODEL || defaultModel) {
    this.client = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0 });
  }
  async enviar(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<Response> {
    const response = await this.client.chat.completions.create({ model: this.model, messages, tools, max_completion_tokens: 2048 }, { signal });
    const choice = response.choices[0];
    if (!choice) throw new Error('Respuesta sin opciones');
    const message = choice.message;
    return {
      message: {
        role: 'assistant',
        content: message.content,
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.function.name, arguments: call.function.arguments } })) } : {})
      },
      finishReason: choice.finish_reason,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0
    };
  }
}
