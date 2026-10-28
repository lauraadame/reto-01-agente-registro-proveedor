import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos } from './src/tools/proveedor.js';
import { fixtureRoot } from './src/tools/storage.js';
import type { Campo, Contexto, Mapeo } from './src/tools/types.js';

const ctx: Contexto = { directory: process.cwd(), sessionId: 'demo' };
const decode = <T>(text: string): T => {
  const parsed: { ok: boolean; data?: T; error?: string } = JSON.parse(text);
  if (!parsed.ok || !parsed.data) throw new Error(parsed.error ?? 'Error de herramienta');
  return parsed.data;
};

await rm(path.join(ctx.directory, 'out'), { recursive: true, force: true });
const casos = (await readdir(path.join(fixtureRoot(ctx), 'casos'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
for (const caso of casos) {
  try {
    const solicitud = decode<{ formato: string; campos: Campo[] }>(await leer_solicitud.execute({ caso }, ctx));
    const mapeo = decode<Mapeo>(await mapear_campos.execute({ caso, campos: solicitud.campos }, ctx));
    const formulario = decode<{ ruta: string }>(await generar_formulario.execute({ caso, mapeo }, ctx));
    const paquete = decode<{ listo_para_firma: boolean; checklist: { estado: string }[] }>(await armar_paquete.execute({ caso }, ctx));
    console.log(`${caso}: ${solicitud.formato} ${formulario.ruta} | llenos=${mapeo.llenos.length} faltantes=${mapeo.faltantes.length} confirmar=${mapeo.requiere_confirmacion.length} | soportes=${paquete.checklist.map(i => i.estado).join(',')} | listo=${paquete.listo_para_firma}`);
  } catch (error) {
    console.error(`${caso}: ${error instanceof Error ? error.message : 'error'}`);
    process.exitCode = 1;
  }
}
