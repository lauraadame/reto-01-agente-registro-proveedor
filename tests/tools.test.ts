import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio } from '../src/tools/proveedor.js';
import type { Campo, Contexto, Mapeo } from '../src/tools/types.js';

let ctx: Contexto;
const root = path.resolve(process.cwd(), 'fixtures', 'reto-01');
const decode = <T>(text: string): { ok: boolean; data?: T; error?: string } => JSON.parse(text);
async function processCase(caso: string) {
  const solicitud = decode<{ campos: Campo[] }>(await leer_solicitud.execute({ caso }, ctx));
  expect(solicitud.ok).toBe(true);
  const mapping = decode<Mapeo>(await mapear_campos.execute({ caso, campos: solicitud.data!.campos }, ctx));
  expect(mapping.ok).toBe(true);
  const form = decode<{ ruta: string }>(await generar_formulario.execute({ caso, mapeo: mapping.data! }, ctx));
  expect(form.ok).toBe(true);
  const packageResult = decode<{ listo_para_firma: boolean; checklist: { estado: string }[] }>(await armar_paquete.execute({ caso }, ctx));
  expect(packageResult.ok).toBe(true);
  return { solicitud: solicitud.data!, mapping: mapping.data!, form: form.data!, packageResult: packageResult.data! };
}
beforeEach(async () => { ctx = { directory: await mkdtemp(path.join(os.tmpdir(), 'proveedor-')), sessionId: 'test' }; process.env.FIXTURES_DIR = root; });
afterEach(async () => { await rm(ctx.directory, { recursive: true, force: true }); delete process.env.FIXTURES_DIR; });

describe('herramientas', () => {
  it('escribe Excel exactamente en las celdas y registra trazabilidad sin insertar datos bancarios en el correo', async () => {
    const data = await processCase('co-industrias-delta');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(ctx.directory, data.form.ruta));
    expect(workbook.getWorksheet('Datos Proveedor')?.getCell('C4').value).toBe('900123456');
    expect(workbook.getWorksheet('Datos Bancarios')?.getCell('C5').value).toBe('03100012345');
    expect(data.mapping.llenos.find(item => item.etiqueta === 'NIT')?.fuente).toBe('maestro.nit');
    expect(await readFile(path.join(ctx.directory, 'out/co-industrias-delta/paquete/borrador-correo.md'), 'utf8')).not.toContain('03100012345');
    expect(data.packageResult.listo_para_firma).toBe(false);
    expect(data.packageResult.checklist.some(item => item.estado === 'vencido')).toBe(true);
  });
  it('produce PDF válido con campo faltante, NIT extranjero por confirmar y soporte ausente', async () => {
    const data = await processCase('ec-corp-andina');
    expect(data.mapping.faltantes.map(item => item.etiqueta)).toContain('Número de contribuyente especial');
    expect(data.mapping.requiere_confirmacion.find(item => item.etiqueta === 'RUC')?.nota).toContain('identificador extranjero');
    expect(data.packageResult.checklist.some(item => item.estado === 'ausente')).toBe(true);
    expect((await PDFDocument.load(await readFile(path.join(ctx.directory, data.form.ruta)))).getPageCount()).toBeGreaterThan(0);
  });
  it('marca RTN extranjero, referencias comerciales faltantes y parafiscales vencidos', async () => {
    const data = await processCase('hn-agroexport-sula');
    expect(data.mapping.requiere_confirmacion.find(item => item.etiqueta === 'RTN')).toBeDefined();
    expect(data.mapping.faltantes.find(item => item.etiqueta === 'Referencias comerciales')).toBeDefined();
    expect(data.packageResult.checklist.find(item => item.estado === 'vencido')).toBeDefined();
  });
  it('entrega valores portal pero no declara listo para firma', async () => {
    const data = await processCase('pa-logistica-istmo');
    expect(data.form.ruta).toContain('valores-portal.md');
    expect(data.packageResult.listo_para_firma).toBe(false);
    expect(await readFile(path.join(ctx.directory, data.form.ruta), 'utf8')).toContain('Formato no soportado');
  });
  it('rechaza caso inexistente, mapeo falsificado, plantilla corrupta y envío no confirmado', async () => {
    expect(decode(await leer_solicitud.execute({ caso: '../otro' }, ctx)).ok).toBe(false);
    expect(decode(await leer_solicitud.execute({ caso: 'no-existe' }, ctx)).ok).toBe(false);
    const data = await processCase('co-industrias-delta');
    const forged = structuredClone(data.mapping);
    forged.llenos[0]!.valor = 'inventado';
    expect(decode(await generar_formulario.execute({ caso: 'co-industrias-delta', mapeo: forged }, ctx)).ok).toBe(false);
    expect(decode(await simular_envio.execute({ caso: 'co-industrias-delta', confirmado: false }, ctx)).error).toBe('requiere confirmación explícita');
    const corruptRoot = path.join(ctx.directory, 'corrupt');
    const caseDir = path.join(corruptRoot, 'casos', 'prueba');
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, 'solicitud.json'), JSON.stringify({ id: 'prueba', pais: 'CO', cliente: 'Prueba', formato: 'xlsx', cuerpo: '' }));
    await writeFile(path.join(caseDir, 'soportes-exigidos.json'), '[]');
    await writeFile(path.join(caseDir, 'plantilla-celdas.json'), '{');
    process.env.FIXTURES_DIR = corruptRoot;
    const response = decode<{ plantillaError: string }>(await leer_solicitud.execute({ caso: 'prueba' }, ctx));
    expect(response.ok).toBe(true);
    expect(response.data?.plantillaError).toContain('corrupta');
  });
  it('registra llamadas en log global y log por caso', async () => {
    await leer_solicitud.execute({ caso: 'co-industrias-delta' }, ctx);
    expect(await readFile(path.join(ctx.directory, 'out/log.jsonl'), 'utf8')).toContain('proveedor_leer_solicitud');
    expect(await readFile(path.join(ctx.directory, 'out/co-industrias-delta/log.jsonl'), 'utf8')).toContain('proveedor_leer_solicitud');
  });
});
