import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Contexto } from './types.js';

export const casoSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
export const fixtureRoot = (ctx: Contexto) => path.resolve(ctx.directory, process.env.FIXTURES_DIR || './fixtures/reto-01');
export const caseRoot = (ctx: Contexto, caso: string) => path.join(fixtureRoot(ctx), 'casos', caso);
export const outRoot = (ctx: Contexto, caso: string) => path.join(ctx.directory, 'out', caso);
export async function jsonFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(file, 'utf8')));
}
export function errorText(error: unknown): string {
  if (error instanceof z.ZodError) return 'Archivo o argumentos inválidos: ' + error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; ');
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'Caso o archivo requerido inexistente';
  return error instanceof Error ? error.message : 'Error inesperado';
}
export async function logTool(ctx: Contexto, caso: string | undefined, herramienta: string, ok: boolean, resumen: string): Promise<void> {
  const record = JSON.stringify({ ts: new Date().toISOString(), herramienta, ok, resumen }) + '\n';
  const global = path.join(ctx.directory, 'out');
  await mkdir(global, { recursive: true });
  await appendFile(path.join(global, 'log.jsonl'), record);
  if (caso && casoSchema.safeParse(caso).success) {
    const dir = outRoot(ctx, caso);
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, 'log.jsonl'), record);
  }
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}
export async function result<T>(ctx: Contexto, caso: string | undefined, name: string, action: () => Promise<T>): Promise<string> {
  try {
    const data = await action();
    await logTool(ctx, caso, name, true, 'Operación completada');
    return JSON.stringify({ ok: true, data });
  } catch (error) {
    const message = errorText(error);
    try { await logTool(ctx, caso, name, false, message); } catch { return JSON.stringify({ ok: false, error: message }); }
    return JSON.stringify({ ok: false, error: message });
  }
}
