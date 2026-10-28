import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LlmAdapter, Message, ToolDefinition } from './llm/adapter.js';
import { herramientas, type ToolName } from './tools/proveedor.js';
import { campoSchema, mapeoSchema, type Campo, type Contexto, type Mapeo } from './tools/types.js';
import { casoSchema, logTool } from './tools/storage.js';

export type ToolCall = { name: string; arguments: unknown; result: string };
export type Turn = { role: 'user' | 'assistant'; text: string; toolCalls?: ToolCall[]; needsConfirmation?: boolean; caseId?: string };
type Pending = { caso: string; turn: number };
export type Session = { id: string; history: Turn[]; messages: Message[]; tokens: number; pending?: Pending; busy: boolean };
export type ChatResult = { sessionId: string; reply: string; toolCalls: ToolCall[]; needsConfirmation: boolean; caseId?: string; error?: string };
const toolSchemas = {
  proveedor_leer_solicitud: z.object({ caso: casoSchema }).strict(),
  proveedor_mapear_campos: z.object({ caso: casoSchema, campos: z.array(campoSchema) }).strict(),
  proveedor_generar_formulario: z.object({ caso: casoSchema, mapeo: mapeoSchema }).strict(),
  proveedor_armar_paquete: z.object({ caso: casoSchema }).strict(),
  proveedor_simular_envio: z.object({ caso: casoSchema, confirmado: z.boolean() }).strict()
};
const cases = ['co-industrias-delta', 'ec-corp-andina', 'hn-agroexport-sula', 'pa-logistica-istmo'];
const isConfirmation = (message: string) => /^(?:s[ií]|confirmo|autorizo|apruebo|env[ií]a|simula(?: el)? env[ií]o)(?:[\s.,!]+(?:el|env[ií]o|de|del|caso|para|simulado|simula|ahora|co-industrias-delta|ec-corp-andina|hn-agroexport-sula|pa-logistica-istmo))*[\s.!]*$/i.test(message.trim());
const maxIterations = () => Math.max(1, Math.min(50, Number(process.env.MAX_TOOL_ITERATIONS) || 25));
const maxTokens = () => Math.max(1000, Number(process.env.MAX_SESSION_TOKENS) || 30000);
const timeoutMs = () => Math.max(1000, Number(process.env.LLM_TIMEOUT_MS) || 60000);

export class Agent {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly directory: string, private readonly adapter?: LlmAdapter) {}
  get(id: string): Session | undefined { return this.sessions.get(id); }
  private create(): Session {
    const session: Session = { id: randomUUID(), history: [], messages: [], tokens: 0, busy: false };
    this.sessions.set(session.id, session);
    return session;
  }
  private definitions(): ToolDefinition[] {
    return Object.entries(herramientas).map(([name, tool]) => ({ type: 'function', function: { name, description: tool.description, parameters: schemaFor(name as ToolName) } }));
  }
  async chat(sessionId: string | undefined, message: string): Promise<ChatResult> {
    const session = sessionId ? this.get(sessionId) : this.create();
    if (!session) return { sessionId: sessionId ?? '', reply: 'Sesión no encontrada. Inicia una conversación nueva.', toolCalls: [], needsConfirmation: false, error: 'session_not_found' };
    if (session.busy) return { sessionId: session.id, reply: 'Esta sesión tiene una solicitud en curso.', toolCalls: [], needsConfirmation: false, error: 'busy' };
    session.busy = true;
    try { return await this.turn(session, message); } finally { session.busy = false; }
  }
  private async turn(session: Session, message: string): Promise<ChatResult> {
    const prior = session.pending;
    const explicitCase = message.match(/\b(?:co-industrias-delta|ec-corp-andina|hn-agroexport-sula|pa-logistica-istmo)\b/gi)?.[0];
    const normalized = message.trim().replace(/^confirmo[.!]?\s*/i, 'Confirmo ');
    const confirmed = !!prior && prior.turn === session.history.length && isConfirmation(normalized) && (!explicitCase || explicitCase.toLowerCase() === prior.caso);
    session.pending = undefined;
    session.history.push({ role: 'user', text: message });
    const calls: ToolCall[] = [];
    const failed = (reply: string, error: string): ChatResult => {
      session.history.push({ role: 'assistant', text: reply, toolCalls: calls, needsConfirmation: false });
      return { sessionId: session.id, reply, toolCalls: calls, needsConfirmation: false, error };
    };
    if (!this.adapter) return failed('No hay clave de Groq configurada. Añade GROQ_API_KEY en el backend y vuelve a intentar.', 'missing_api_key');
    if (session.tokens >= maxTokens()) return failed('Esta sesión alcanzó su límite de tokens. Inicia una sesión nueva.', 'token_limit');
    const ctx: Contexto = { directory: this.directory, sessionId: session.id };
    if (confirmed && prior) {
      const output = await herramientas.proveedor_simular_envio.execute({ caso: prior.caso, confirmado: true }, ctx);
      const call = { name: 'proveedor_simular_envio', arguments: { caso: prior.caso, confirmado: true }, result: summarize(output) };
      const parsed = JSON.parse(output) as { ok: boolean; data?: { ruta?: string }; error?: string };
      const reply = parsed.ok ? `Simulación registrada en ${parsed.data?.ruta ?? 'el directorio de salida'}. No se envió ningún correo.` : `No se pudo simular el envío: ${parsed.error ?? 'error desconocido'}.`;
      session.messages.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
      session.history.push({ role: 'assistant', text: reply, toolCalls: [call], needsConfirmation: false, caseId: prior.caso });
      return { sessionId: session.id, reply, toolCalls: [call], needsConfirmation: false, caseId: prior.caso, ...(!parsed.ok ? { error: 'simulation_failed' } : {}) };
    }
    const system = await readFile(path.join(this.directory, 'agent', 'prompt.md'), 'utf8');
    const knowledge = await readFile(path.join(this.directory, 'src', 'knowledge', 'registro-proveedor.md'), 'utf8');
    const working: Message[] = [{ role: 'system', content: system + '\n\n' + knowledge }, ...session.messages, { role: 'user', content: message }];
    if (confirmed && prior) working[working.length - 1] = { role: 'user', content: `${message}\n\nAutorización validada por el servidor únicamente para ${prior.caso}. Llama proveedor_simular_envio para ese caso.` };
    let currentCase: string | undefined;
    let preparedCase: string | undefined;
    let simulated = false;
    let lastText = '';
    let completed = false;
    let packageData: { listo_para_firma: boolean; checklist: { tipo: string; estado: string; vigencia_hasta: string | null }[]; faltantes: string[]; requiere_confirmacion: string[]; ruta: string } | undefined;
    const verifiedFields = new Map<string, Campo[]>();
    const verifiedMappings = new Map<string, Mapeo>();
    for (let iteration = 0; iteration < maxIterations(); iteration++) {
      if (session.tokens >= maxTokens()) break;
      let response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs());
      try {
        response = await this.adapter.enviar(working, this.definitions(), controller.signal);
      } catch {
        clearTimeout(timer);
        const fields = currentCase ? verifiedFields.get(currentCase) : undefined;
        if (!confirmed && currentCase && fields) {
          const mappedOutput = await herramientas.proveedor_mapear_campos.execute({ caso: currentCase, campos: fields }, ctx);
          const mappedResult = JSON.parse(mappedOutput) as { ok: boolean; data?: Mapeo };
          calls.push({ name: 'proveedor_mapear_campos', arguments: { caso: currentCase, campos: '[campos verificados por el servidor]' }, result: summarize(mappedOutput) });
          if (mappedResult.ok && mappedResult.data) {
            verifiedMappings.set(currentCase, mappedResult.data);
            const formOutput = await herramientas.proveedor_generar_formulario.execute({ caso: currentCase, mapeo: mappedResult.data }, ctx);
            calls.push({ name: 'proveedor_generar_formulario', arguments: { caso: currentCase, mapeo: '[mapeo verificado por el servidor]' }, result: summarize(formOutput) });
            const packageOutput = await herramientas.proveedor_armar_paquete.execute({ caso: currentCase }, ctx);
            const packageResult = JSON.parse(packageOutput) as { ok: boolean; data?: typeof packageData };
            calls.push({ name: 'proveedor_armar_paquete', arguments: { caso: currentCase }, result: summarize(packageOutput) });
            if (packageResult.ok && packageResult.data) {
              packageData = packageResult.data;
              preparedCase = currentCase;
              completed = true;
              break;
            }
          }
        }
        if (working.at(-1)?.role !== 'tool') session.messages = working.slice(1, -1);
        else session.messages = working.slice(1);
        return failed('No se pudo consultar el modelo (timeout, conexión o credenciales). Revisa la configuración y vuelve a intentar.', 'provider_error');
      }
      clearTimeout(timer);
      session.tokens += response.inputTokens + response.outputTokens;
      const text = response.message.content?.trim() ?? '';
      if (text) lastText = text;
      const uses = response.message.tool_calls ?? [];
      working.push(response.finishReason === 'tool_calls' || !uses.length ? response.message : { role: 'assistant', content: response.message.content });
      if (!uses.length) {
        completed = response.finishReason === 'stop';
        break;
      }
      if (response.finishReason !== 'tool_calls') break;
      for (const use of uses) {
        const name = use.function.name as ToolName;
        let input: unknown;
        try { input = JSON.parse(use.function.arguments); } catch { input = undefined; }
        const schema = toolSchemas[name];
        const parse = schema?.safeParse(input);
        let output: string;
        const caso = typeof input === 'object' && input !== null && 'caso' in input && typeof input.caso === 'string' ? input.caso : undefined;
        if (!schema || !parse?.success) {
          output = JSON.stringify({ ok: false, error: 'Argumentos de herramienta inválidos' });
          await logTool(ctx, caso, use.function.name, false, 'Argumentos inválidos');
        } else if (name === 'proveedor_simular_envio') {
          const allowed = !!prior && confirmed && prior.caso === caso && !simulated && session.history.length >= 2;
          if (!allowed) {
            output = JSON.stringify({ ok: false, error: 'requiere confirmación explícita del turno inmediatamente anterior para este caso' });
            await logTool(ctx, caso, name, false, 'Confirmación ausente o no corresponde al caso');
          } else {
            output = await herramientas.proveedor_simular_envio.execute({ caso: prior.caso, confirmado: true }, ctx);
            simulated = JSON.parse(output).ok === true;
          }
        } else if (name === 'proveedor_leer_solicitud') {
          output = await herramientas.proveedor_leer_solicitud.execute(parse.data as { caso: string }, ctx);
          const result = JSON.parse(output) as { ok: boolean; data?: { campos?: Campo[] } };
          if (result.ok && caso && result.data?.campos) verifiedFields.set(caso, result.data.campos);
        } else if (name === 'proveedor_mapear_campos') {
          const data = parse.data as Parameters<typeof herramientas.proveedor_mapear_campos.execute>[0];
          output = await herramientas.proveedor_mapear_campos.execute({ ...data, campos: verifiedFields.get(data.caso) ?? data.campos }, ctx);
          const result = JSON.parse(output) as { ok: boolean; data?: Mapeo };
          if (result.ok && result.data) verifiedMappings.set(data.caso, result.data);
        } else if (name === 'proveedor_generar_formulario') {
          const data = parse.data as Parameters<typeof herramientas.proveedor_generar_formulario.execute>[0];
          output = await herramientas.proveedor_generar_formulario.execute({ ...data, mapeo: verifiedMappings.get(data.caso) ?? data.mapeo }, ctx);
        } else {
          output = await herramientas.proveedor_armar_paquete.execute(parse.data as { caso: string }, ctx);
          const result = JSON.parse(output) as { ok: boolean; data?: typeof packageData };
          if (result.ok && result.data) packageData = result.data;
        }
        if (caso && JSON.parse(output).ok === true && name !== 'proveedor_simular_envio') {
          currentCase = caso;
          if (name === 'proveedor_armar_paquete') preparedCase = caso;
          if (prior && caso !== prior.caso) preparedCase = undefined;
        }
        calls.push({ name: use.function.name, arguments: name === 'proveedor_simular_envio' ? { caso, confirmado: simulated } : input ?? use.function.arguments, result: summarize(output) });
        working.push({ role: 'tool', tool_call_id: use.id, content: output });
      }
    }
    if (!confirmed && currentCase && verifiedMappings.has(currentCase) && !preparedCase) {
      if (!calls.some(call => call.name === 'proveedor_generar_formulario')) {
        const output = await herramientas.proveedor_generar_formulario.execute({ caso: currentCase, mapeo: verifiedMappings.get(currentCase)! }, ctx);
        calls.push({ name: 'proveedor_generar_formulario', arguments: { caso: currentCase, mapeo: '[mapeo verificado por el servidor]' }, result: summarize(output) });
      }
      const output = await herramientas.proveedor_armar_paquete.execute({ caso: currentCase }, ctx);
      const result = JSON.parse(output) as { ok: boolean; data?: typeof packageData };
      calls.push({ name: 'proveedor_armar_paquete', arguments: { caso: currentCase }, result: summarize(output) });
      if (result.ok && result.data) {
        packageData = result.data;
        preparedCase = currentCase;
        completed = true;
      }
    }
    const caseId = preparedCase ?? currentCase ?? (prior?.caso && confirmed ? prior.caso : undefined);
    const needsConfirmation = !!preparedCase && completed && !simulated && (!prior || preparedCase !== prior.caso || !confirmed) && !calls.some(call => call.name === 'proveedor_simular_envio');
    const denied = calls.some(call => call.name === 'proveedor_simular_envio' && call.result.includes('requiere confirmación'));
    const fallback = denied ? 'No se simuló ningún envío: falta confirmación válida para este caso.' : 'Proceso interrumpido por el límite de iteraciones. Revisa las llamadas a herramientas y los pendientes.';
    const verifiedReply = packageData && preparedCase ? packageSummary(preparedCase, verifiedMappings.get(preparedCase), packageData) : undefined;
    const reply = (denied ? fallback : verifiedReply ?? (!completed ? `${lastText ? `${lastText}\n\n` : ''}Proceso interrumpido por el límite de iteraciones o tokens. Revisa las llamadas a herramientas y los pendientes.` : lastText || fallback)) + (needsConfirmation ? `\n\n¿Confirmas que deseas simular el envío del caso ${preparedCase}? No se enviará nada realmente.` : '');
    if (needsConfirmation && preparedCase) session.pending = { caso: preparedCase, turn: session.history.length + 1 };
    session.messages = working.slice(1);
    session.history.push({ role: 'assistant', text: reply, toolCalls: calls, needsConfirmation, caseId });
    return { sessionId: session.id, reply, toolCalls: calls, needsConfirmation, caseId };
  }
}

function packageSummary(caso: string, mapping: Mapeo | undefined, data: { listo_para_firma: boolean; checklist: { tipo: string; estado: string; vigencia_hasta: string | null }[]; faltantes: string[]; requiere_confirmacion: string[]; ruta: string }): string {
  const support = data.checklist.map(item => `- ${item.tipo}: ${item.estado}${item.vigencia_hasta ? ` (vigencia hasta ${item.vigencia_hasta})` : ''}`).join('\n');
  return `Caso **${caso}** procesado con datos verificados.\n\n- Campos llenos: ${mapping?.llenos.length ?? 0}\n- Campos faltantes: ${data.faltantes.length ? data.faltantes.join(', ') : 'ninguno'}\n- Requieren confirmación: ${data.requiere_confirmacion.length ? data.requiere_confirmacion.join('; ') : 'ninguno'}\n- Listo para firma: ${data.listo_para_firma ? 'sí' : 'no'}\n- Paquete: ${data.ruta}\n\nSoportes:\n${support}`;
}

function summarize(text: string): string {
  const parsed: { ok: boolean; data?: unknown; error?: string } = JSON.parse(text);
  if (!parsed.ok) return parsed.error ?? 'Error';
  const data = parsed.data as Record<string, unknown> | undefined;
  if (!data) return 'Completado';
  if ('llenos' in data) return `Llenos: ${(data.llenos as unknown[]).length}; faltantes: ${(data.faltantes as unknown[]).length}; por confirmar: ${(data.requiere_confirmacion as unknown[]).length}`;
  if ('listo_para_firma' in data) return `Listo para firma: ${data.listo_para_firma}; soportes: ${JSON.stringify(data.checklist)}`;
  if ('campos' in data) return `Formato: ${data.formato}; campos: ${(data.campos as unknown[]).length}; soportes: ${(data.soportes as unknown[]).length}`;
  return String(data.ruta ?? 'Completado');
}

function schemaFor(name: ToolName): Record<string, unknown> {
  const campo = { type: 'object', properties: { etiqueta: { type: 'string' }, obligatorio: { type: 'boolean' }, hoja: { type: 'string' }, celda_etiqueta: { type: 'string' }, celda_valor: { type: 'string' } }, required: ['etiqueta'], additionalProperties: false };
  const props: Record<string, unknown> = { caso: { type: 'string', description: herramientas[name].args.caso.description } };
  if (name === 'proveedor_mapear_campos') props.campos = { type: 'array', items: campo, description: herramientas.proveedor_mapear_campos.args.campos.description };
  if (name === 'proveedor_generar_formulario') props.mapeo = { type: 'object', properties: Object.fromEntries(['llenos', 'faltantes', 'requiere_confirmacion'].map(key => [key, { type: 'array', items: { type: 'object', properties: { etiqueta: { type: 'string' }, estado: { type: 'string' }, valor: { type: ['string', 'number', 'boolean'] }, fuente: { type: 'string' }, confianza: { type: 'number' }, nota: { type: 'string' } }, required: ['etiqueta', 'estado', 'confianza'], additionalProperties: false } }])), required: ['llenos', 'faltantes', 'requiere_confirmacion'], additionalProperties: false, description: herramientas.proveedor_generar_formulario.args.mapeo.description };
  if (name === 'proveedor_simular_envio') props.confirmado = { type: 'boolean', description: herramientas.proveedor_simular_envio.args.confirmado.description };
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

export const validCases = cases;
