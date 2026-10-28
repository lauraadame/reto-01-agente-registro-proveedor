import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { LlmAdapter, Message, Response, ToolCall, ToolDefinition } from '../src/llm/adapter.js';
import { createApp } from '../src/server.js';
import type { Campo } from '../src/tools/types.js';

const toolCall = (id: string, name: string, args: unknown): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

class FakeAdapter implements LlmAdapter {
  calls = 0;
  constructor(private readonly caseId: string, private readonly campos: Campo[], private readonly attemptedCase?: string) {}
  async enviar(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<Response> {
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]?.content).toContain('Reglas');
    expect(tools).toHaveLength(5);
    expect(tools[0]).toMatchObject({ type: 'function', function: { parameters: { type: 'object' } } });
    expect(signal.aborted).toBe(false);
    if (this.calls === 1) {
      expect(messages.filter(item => item.role === 'tool')).toHaveLength(1);
      expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'read' });
    }
    this.calls++;
    let message: Response['message'];
    if (this.calls === 1) message = { role: 'assistant', content: null, tool_calls: [toolCall('read', 'proveedor_leer_solicitud', { caso: this.caseId })] };
    else if (this.calls === 2) message = { role: 'assistant', content: null, tool_calls: [toolCall('map', 'proveedor_mapear_campos', { caso: this.caseId, campos: this.campos })] };
    else if (this.calls === 3) message = { role: 'assistant', content: null, tool_calls: [toolCall('pack', 'proveedor_armar_paquete', { caso: this.caseId })] };
    else if (this.calls === 4) message = { role: 'assistant', content: 'Paquete preparado. Revisa el checklist.' };
    else if (this.calls === 5) message = { role: 'assistant', content: null, tool_calls: [toolCall('send', 'proveedor_simular_envio', { caso: this.attemptedCase ?? this.caseId, confirmado: true })] };
    else message = { role: 'assistant', content: 'Resultado de simulación disponible.' };
    return { message, finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop', inputTokens: 10, outputTokens: 10 };
  }
}
let temp: string;
const fixture = path.resolve(process.cwd(), 'fixtures', 'reto-01');
const caso = 'co-industrias-delta';
let campos: Campo[];
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'api-proveedor-'));
  process.env.FIXTURES_DIR = fixture;
  await mkdir(path.join(temp, 'agent'), { recursive: true });
  await mkdir(path.join(temp, 'src/knowledge'), { recursive: true });
  await writeFile(path.join(temp, 'agent/prompt.md'), 'Usa las herramientas.');
  await writeFile(path.join(temp, 'src/knowledge/registro-proveedor.md'), 'Reglas del proceso.');
  campos = JSON.parse(await readFile(path.join(fixture, 'casos', caso, 'plantilla-celdas.json'), 'utf8'));
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); delete process.env.FIXTURES_DIR; });

describe('API y gate humano', () => {
  it('atiende health y mensaje sin clave; conserva sesión y errores recuperables', async () => {
    const { app } = createApp({ directory: temp, configured: false });
    expect((await request(app).get('/api/health')).body).toMatchObject({ ok: true, provider: 'groq', model: 'openai/gpt-oss-20b', configured: false });
    const response = await request(app).post('/api/chat').send({ message: 'hola' });
    expect(response.body.error).toBe('missing_api_key');
    expect(response.body.reply).toContain('GROQ_API_KEY');
    expect((await request(app).get(`/api/sessions/${response.body.sessionId}`)).body.history).toHaveLength(2);
    expect((await request(app).post('/api/chat').send({ message: '' })).status).toBe(400);
    expect((await request(app).get('/api/sessions/unknown')).status).toBe(404);
  });
  it('muestra herramientas y autoriza simulación solo tras confirmación inmediata del mismo caso', async () => {
    const adapter = new FakeAdapter(caso, campos);
    const { app, agent } = createApp({ directory: temp, adapter, configured: true });
    const first = (await request(app).post('/api/chat').send({ message: 'Procesa el caso' })).body;
    expect(first.toolCalls.map((call: { name: string }) => call.name)).toEqual(['proveedor_leer_solicitud', 'proveedor_mapear_campos', 'proveedor_armar_paquete']);
    expect(first.needsConfirmation).toBe(true);
    expect(agent.get(first.sessionId)?.messages[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'read' }] });
    const second = (await request(app).post('/api/chat').send({ sessionId: first.sessionId, message: 'Confirmo. Simula el envío.' })).body;
    expect(second.toolCalls[0].result).toContain('ENVIO-SIMULADO.md');
    expect(await readFile(path.join(temp, 'out', caso, 'ENVIO-SIMULADO.md'), 'utf8')).toContain('No se envió correo');
  });
  it('niega confirmado:true del modelo cuando el humano niega y consume la confirmación', async () => {
    const adapter = new FakeAdapter(caso, campos);
    const { app } = createApp({ directory: temp, adapter, configured: true });
    const first = (await request(app).post('/api/chat').send({ message: 'Procesa' })).body;
    const response = (await request(app).post('/api/chat').send({ sessionId: first.sessionId, message: 'No, todavía no' })).body;
    expect(response.toolCalls[0].result).toContain('requiere confirmación explícita');
    await expect(readFile(path.join(temp, 'out', caso, 'ENVIO-SIMULADO.md'))).rejects.toThrow();
  });
  it('niega una simulación para otro caso aunque haya confirmación', async () => {
    const adapter = new FakeAdapter(caso, campos, 'ec-corp-andina');
    const { app } = createApp({ directory: temp, adapter, configured: true });
    const first = (await request(app).post('/api/chat').send({ message: 'Procesa' })).body;
    const response = (await request(app).post('/api/chat').send({ sessionId: first.sessionId, message: 'Sí, envía el caso ec-corp-andina.' })).body;
    expect(response.toolCalls[0].result).toContain('requiere confirmación explícita');
  });
  it('devuelve error de herramienta ante argumentos JSON inválidos y continúa el turno', async () => {
    const messagesSeen: Message[][] = [];
    const adapter: LlmAdapter = {
      async enviar(messages) {
        messagesSeen.push([...messages]);
        if (messagesSeen.length === 1) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'proveedor_leer_solicitud', arguments: '{invalid' } }] }, finishReason: 'tool_calls', inputTokens: 2, outputTokens: 3 };
        return { message: { role: 'assistant', content: 'Continúo sin ejecutar esa herramienta.' }, finishReason: 'stop', inputTokens: 2, outputTokens: 3 };
      }
    };
    const { app, agent } = createApp({ directory: temp, adapter, configured: true });
    const result = (await request(app).post('/api/chat').send({ message: 'Procesa' })).body;
    expect(result.error).toBeUndefined();
    expect(result.toolCalls[0].result).toBe('Argumentos de herramienta inválidos');
    expect(result.reply).toBe('Continúo sin ejecutar esa herramienta.');
    expect(messagesSeen[1]?.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'bad', content: '{"ok":false,"error":"Argumentos de herramienta inválidos"}' });
    expect(agent.get(result.sessionId)?.tokens).toBe(10);
  });
  it('trata finish_reason length como interrupción sin solicitar confirmación', async () => {
    const adapter: LlmAdapter = { async enviar() { return { message: { role: 'assistant', content: 'Respuesta parcial' }, finishReason: 'length', inputTokens: 1, outputTokens: 2 }; } };
    const { app } = createApp({ directory: temp, adapter, configured: true });
    const result = (await request(app).post('/api/chat').send({ message: 'Procesa' })).body;
    expect(result.reply).toContain('Proceso interrumpido');
    expect(result.needsConfirmation).toBe(false);
  });
});
