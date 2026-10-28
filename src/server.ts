import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Agent } from './agent.js';
import { GroqAdapter, defaultModel } from './llm/groq.js';
import type { LlmAdapter } from './llm/adapter.js';

const directory = path.resolve(process.cwd());
const payload = z.object({ sessionId: z.string().uuid().optional(), message: z.string().trim().min(1).max(4000) }).strict();
export function createApp(options: { directory?: string; adapter?: LlmAdapter; configured?: boolean } = {}) {
  const root = options.directory ?? directory;
  const configured = options.configured ?? !!process.env.GROQ_API_KEY;
  const agent = new Agent(root, options.adapter ?? (configured ? new GroqAdapter() : undefined));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, provider: 'groq', model: process.env.MODEL || defaultModel, configured }));
  app.get('/api/sessions/:id', (req, res) => {
    const session = agent.get(req.params.id);
    if (!session) { res.status(404).json({ error: 'Sesión no encontrada' }); return; }
    res.json({ sessionId: session.id, history: session.history, tokens: session.tokens, needsConfirmation: !!session.pending });
  });
  app.post('/api/chat', async (req, res) => {
    const parsed = payload.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Mensaje o identificador de sesión inválido' }); return; }
    try { res.json(await agent.chat(parsed.data.sessionId, parsed.data.message)); }
    catch { res.status(500).json({ error: 'No se pudo procesar el turno; intenta de nuevo' }); }
  });
  app.use(express.static(path.join(root, 'web')));
  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  return { app, agent };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().app.listen(port, () => console.log(`Servidor listo en puerto ${port}`));
}
