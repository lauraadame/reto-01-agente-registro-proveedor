import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { z } from 'zod';
import { campoSchema, mapeoSchema, type Campo, type Contexto, type Item, type Mapeo } from './types.js';
import { casoSchema, caseRoot, fixtureRoot, jsonFile, outRoot, result, saveJson } from './storage.js';

const solicitudSchema = z.object({ id: z.string(), pais: z.enum(['CO', 'EC', 'PE', 'PA', 'HN']), cliente: z.string(), formato: z.enum(['xlsx', 'pdf', 'portal']), cuerpo: z.string() }).passthrough();
const xlsxSchema = z.array(campoSchema.extend({ hoja: z.string().min(1), celda_etiqueta: z.string().regex(/^[A-Z]+[1-9][0-9]*$/), celda_valor: z.string().regex(/^[A-Z]+[1-9][0-9]*$/) }).strict());
const pdfSchema = z.array(campoSchema.extend({ obligatorio: z.boolean() }).strict());
const soportesSchema = z.array(z.string().min(1));
const indiceSchema = z.array(z.object({ tipo: z.string(), archivo: z.string(), vigencia_hasta: z.string().nullable(), pais_emisor: z.string() }).passthrough());
const maestroSchema = z.record(z.unknown());
const glosarioSchema = z.record(z.string());
const paisId: Record<string, string> = { CO: 'NIT', EC: 'RUC', PE: 'RUC', PA: 'RUC', HN: 'RTN' };

async function caseData(ctx: Contexto, caso: string) {
  casoSchema.parse(caso);
  const root = caseRoot(ctx, caso);
  const solicitud = await jsonFile(path.join(root, 'solicitud.json'), solicitudSchema);
  if (solicitud.id !== caso) throw new Error('La solicitud no corresponde al caso solicitado');
  const filename = solicitud.formato === 'xlsx' ? 'plantilla-celdas.json' : 'plantilla-campos.json';
  let campos: Campo[] = [];
  let plantillaError: string | undefined;
  try {
    if (solicitud.formato === 'xlsx') campos = await jsonFile(path.join(root, filename), xlsxSchema);
    else campos = await jsonFile(path.join(root, filename), pdfSchema);
  } catch {
    plantillaError = 'Plantilla ausente o corrupta; se puede continuar con soportes y faltantes';
  }
  const soportes = await jsonFile(path.join(root, 'soportes-exigidos.json'), soportesSchema);
  return { solicitud, campos, soportes, plantillaError };
}

async function mapped(ctx: Contexto, caso: string, campos: Campo[]): Promise<Mapeo> {
  const { solicitud, campos: originales, plantillaError } = await caseData(ctx, caso);
  if (plantillaError) throw new Error(plantillaError);
  const maestro = await jsonFile(path.join(fixtureRoot(ctx), 'repositorio', 'maestro.json'), maestroSchema);
  const glosario = await jsonFile(path.join(fixtureRoot(ctx), 'glosario-campos.json'), glosarioSchema);
  const keys = new Map(Object.entries(glosario).map(([label, key]) => [label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(), key]));
  if (campos.length !== originales.length || campos.some((campo, index) => Object.entries(originales[index] ?? {}).some(([key, value]) => campo[key as keyof Campo] !== value))) throw new Error('Los campos deben coincidir exactamente con la plantilla del caso');
  const output: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] };
  for (const campo of originales) {
    const label = campo.etiqueta.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const key = keys.get(label);
    const value = key?.split('.').reduce<unknown>((parent, part) => parent !== null && typeof parent === 'object' && part in parent ? (parent as Record<string, unknown>)[part] : undefined, maestro);
    const valid = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    const ambiguous = label === 'identificacion tributaria' || label === 'numero de identificacion fiscal';
    const taxIdentifier = ambiguous || label === 'nit' || label === 'ruc' || label === 'rtn';
    const foreign = key === 'nit' && solicitud.pais !== 'CO' && taxIdentifier;
    const base: Item = { etiqueta: campo.etiqueta, estado: 'faltante', confianza: key ? 1 : 0 };
    if (!valid) {
      output.faltantes.push(base);
    } else if (foreign || ambiguous) {
      output.requiere_confirmacion.push({ ...base, estado: 'requiere_confirmacion', valor: value, fuente: `maestro.${key}`, confianza: foreign ? 0.7 : 0.75, nota: foreign ? `identificador extranjero: se propone NIT colombiano, no ${paisId[solicitud.pais]} local` : `Confirmar equivalente ${paisId[solicitud.pais]}` });
    } else {
      output.llenos.push({ ...base, estado: 'lleno', valor: value, fuente: `maestro.${key}`, confianza: 1 });
    }
  }
  return output;
}

export const leer_solicitud = {
  description: 'Lee correo, plantilla y soportes de un caso de registro sin alterar los fixtures.',
  args: { caso: casoSchema.describe('Nombre de carpeta del caso bajo FIXTURES_DIR/casos') },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return result(ctx, args.caso, 'proveedor_leer_solicitud', async () => {
      const { solicitud, campos, soportes, plantillaError } = await caseData(ctx, args.caso);
      return { pais: solicitud.pais, cliente: solicitud.cliente, formato: solicitud.formato, campos, soportes, ...(plantillaError ? { plantillaError } : {}) };
    });
  }
};

export const mapear_campos = {
  description: 'Cruza todas las etiquetas de la plantilla con el maestro y separa llenos, faltantes y confirmaciones.',
  args: { caso: casoSchema.describe('Caso a mapear'), campos: z.array(campoSchema).describe('Campos completos y en orden devueltos por leer_solicitud') },
  async execute(args: { caso: string; campos: Campo[] }, ctx: Contexto): Promise<string> {
    return result(ctx, args.caso, 'proveedor_mapear_campos', async () => {
      const mapping = await mapped(ctx, args.caso, args.campos);
      await saveJson(path.join(outRoot(ctx, args.caso), 'mapeo.json'), mapping);
      return mapping;
    });
  }
};

function matchMapping(expected: Mapeo, proposed: Mapeo): boolean {
  return JSON.stringify(expected) === JSON.stringify(proposed);
}

async function pdfForm(campos: Campo[], mapping: Mapeo, target: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const items = [...mapping.llenos, ...mapping.faltantes, ...mapping.requiere_confirmacion];
  let page = doc.addPage([612, 792]);
  let y = 740;
  page.drawText('Registro como proveedor', { x: 45, y, size: 17, font: bold, color: rgb(0.1, 0.24, 0.2) });
  y -= 35;
  for (const campo of campos) {
    if (y < 65) { page = doc.addPage([612, 792]); y = 740; }
    const item = items.find(v => v.etiqueta === campo.etiqueta);
    const value = item?.valor === undefined ? '[PENDIENTE]' : String(item.valor);
    const lines = [campo.etiqueta, value];
    for (const [index, text] of lines.entries()) {
      const cleaned = text.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').slice(0, 90);
      page.drawText(cleaned || ' ', { x: 48, y, font: index === 0 ? bold : font, size: index === 0 ? 10 : 11 });
      y -= index === 0 ? 15 : 23;
    }
    page.drawLine({ start: { x: 45, y: y + 8 }, end: { x: 565, y: y + 8 }, thickness: 0.5, color: rgb(0.8, 0.83, 0.8) });
  }
  await writeFile(target, await doc.save());
}

export const generar_formulario = {
  description: 'Genera XLSX, PDF o valores para portal a partir de un mapeo verificado contra el maestro.',
  args: { caso: casoSchema.describe('Caso cuya plantilla se usa'), mapeo: mapeoSchema.describe('Mapeo íntegro obtenido de mapear_campos, verificado de nuevo antes de generar') },
  async execute(args: { caso: string; mapeo: Mapeo }, ctx: Contexto): Promise<string> {
    return result(ctx, args.caso, 'proveedor_generar_formulario', async () => {
      const { solicitud, campos, plantillaError } = await caseData(ctx, args.caso);
      if (plantillaError) throw new Error(plantillaError);
      const expected = await mapped(ctx, args.caso, campos);
      if (!matchMapping(expected, args.mapeo)) throw new Error('Mapeo no coincide con los datos verificables del maestro');
      const dir = outRoot(ctx, args.caso);
      await mkdir(dir, { recursive: true });
      const all = [...expected.llenos, ...expected.faltantes, ...expected.requiere_confirmacion];
      let ruta: string;
      if (solicitud.formato === 'xlsx') {
        ruta = path.join(dir, 'formulario.xlsx');
        const workbook = new ExcelJS.Workbook();
        for (const campo of campos) {
          const sheet = workbook.getWorksheet(campo.hoja ?? '') ?? workbook.addWorksheet(campo.hoja);
          sheet.getCell(campo.celda_etiqueta ?? '').value = campo.etiqueta;
          const item = all.find(row => row.etiqueta === campo.etiqueta);
          sheet.getCell(campo.celda_valor ?? '').value = item?.valor ?? null;
          sheet.getColumn(1).width = 37;
          sheet.getColumn(2).width = 38;
          sheet.getColumn(3).width = 48;
        }
        await workbook.xlsx.writeFile(ruta);
      } else if (solicitud.formato === 'pdf') {
        ruta = path.join(dir, 'formulario.pdf');
        await pdfForm(campos, expected, ruta);
      } else {
        ruta = path.join(dir, 'valores-portal.md');
        const lines = campos.map(c => {
          const item = all.find(row => row.etiqueta === c.etiqueta);
          return `- **${c.etiqueta}**: ${item?.valor === undefined ? '[PENDIENTE]' : String(item.valor)}${item?.nota ? ` — ${item.nota}` : ''}`;
        });
        await writeFile(ruta, `# Valores para portal: ${solicitud.cliente}\n\nFormato no soportado: no se accedió al portal. Copia manual supervisada.\n\n${lines.join('\n')}\n`);
      }
      await saveJson(path.join(dir, 'mapeo.json'), expected);
      return { ruta: path.relative(ctx.directory, ruta), formato: solicitud.formato, ...(solicitud.formato === 'portal' ? { aviso: 'formato no soportado' } : {}) };
    });
  }
};

export const armar_paquete = {
  description: 'Copia el formulario disponible y soportes exigidos y genera checklist, faltantes y correo sin información bancaria.',
  args: { caso: casoSchema.describe('Caso para el que se prepara el paquete de firma') },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return result(ctx, args.caso, 'proveedor_armar_paquete', async () => {
      const { solicitud, campos, soportes, plantillaError } = await caseData(ctx, args.caso);
      const dir = outRoot(ctx, args.caso);
      const paquete = path.join(dir, 'paquete');
      await mkdir(paquete, { recursive: true });
      let mapping: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] };
      if (!plantillaError) {
        mapping = await mapped(ctx, args.caso, campos);
        await saveJson(path.join(dir, 'mapeo.json'), mapping);
      }
      const indice = await jsonFile(path.join(fixtureRoot(ctx), 'repositorio', 'soportes', 'index.json'), indiceSchema);
      const checklist: { tipo: string; estado: 'presente' | 'ausente' | 'vencido'; vigencia_hasta: string | null }[] = [];
      for (const tipo of soportes) {
        const entry = indice.find(i => i.tipo === tipo);
        let exists = false;
        if (entry && path.basename(entry.archivo) === entry.archivo) {
          const source = path.join(fixtureRoot(ctx), 'repositorio', 'soportes', entry.archivo);
          exists = await stat(source).then(s => s.isFile()).catch(() => false);
          if (exists) await copyFile(source, path.join(paquete, entry.archivo));
        }
        checklist.push({ tipo, estado: !exists ? 'ausente' : entry?.vigencia_hasta && entry.vigencia_hasta < new Date().toISOString().slice(0, 10) ? 'vencido' : 'presente', vigencia_hasta: entry?.vigencia_hasta ?? null });
      }
      const formName = solicitud.formato === 'portal' ? 'valores-portal.md' : `formulario.${solicitud.formato}`;
      const source = path.join(dir, formName);
      const formExists = await stat(source).then(s => s.isFile()).catch(() => false);
      if (formExists) await copyFile(source, path.join(paquete, formName));
      const missing = mapping.faltantes.map(item => item.etiqueta);
      const confirmations = mapping.requiere_confirmacion.map(item => `${item.etiqueta}: ${item.nota ?? 'confirmar'}`);
      const report = [`# Checklist — ${solicitud.cliente}`, '', ...checklist.map(i => `- ${i.tipo}: ${i.estado}${i.vigencia_hasta ? ` (vigencia hasta ${i.vigencia_hasta})` : ''}`), '', `Formulario: ${formExists ? formName : 'ausente'}`, `Plantilla: ${plantillaError ?? 'válida'}`, '', '## Campos faltantes', ...missing.map(label => `- ${label}`), ...(missing.length ? [] : ['- Ninguno']), '', '## Requiere confirmación', ...confirmations.map(text => `- ${text}`), ...(confirmations.length ? [] : ['- Ninguno'])].join('\n') + '\n';
      await writeFile(path.join(paquete, 'checklist.md'), report);
      await writeFile(path.join(paquete, 'borrador-correo.md'), `# Borrador para revisión humana\n\nPara: ${solicitud.cliente}\nAsunto: Registro como proveedor — documentos para revisión\n\nEstimados,\n\nAdjuntamos el formulario preparado y los soportes disponibles para revisión y firma del representante legal. Agradecemos confirmar la recepción una vez que el equipo humano autorice el envío.\n\nPendientes de soporte: ${checklist.filter(i => i.estado !== 'presente').map(i => i.tipo).join(', ') || 'ninguno'}.\n\nEste borrador no ha sido enviado.\n`);
      const listo = checklist.every(i => i.estado === 'presente') && formExists && !plantillaError && solicitud.formato !== 'portal';
      return { ruta: path.relative(ctx.directory, paquete), listo_para_firma: listo, checklist, faltantes: missing, requiere_confirmacion: confirmations, formulario: formExists ? formName : null };
    });
  }
};

export const simular_envio = {
  description: 'Registra una simulación local de envío solo después de confirmación explícita comprobada por el backend.',
  args: { caso: casoSchema.describe('Caso autorizado en el turno anterior'), confirmado: z.boolean().describe('Confirmación explícita validada por el backend, no inferida por el modelo') },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Contexto): Promise<string> {
    return result(ctx, args.caso, 'proveedor_simular_envio', async () => {
      if (!args.confirmado) throw new Error('requiere confirmación explícita');
      casoSchema.parse(args.caso);
      await caseData(ctx, args.caso);
      const file = path.join(outRoot(ctx, args.caso), 'ENVIO-SIMULADO.md');
      const packageExists = await stat(path.join(outRoot(ctx, args.caso), 'paquete', 'checklist.md')).then(s => s.isFile()).catch(() => false);
      if (!packageExists) throw new Error('Primero hay que preparar el paquete');
      await writeFile(file, `# Envío simulado\n\nCaso: ${args.caso}\nFecha: ${new Date().toISOString()}\nNo se envió correo ni se firmó ningún documento.\n`);
      return { ruta: path.relative(ctx.directory, file) };
    });
  }
};

export const herramientas = { proveedor_leer_solicitud: leer_solicitud, proveedor_mapear_campos: mapear_campos, proveedor_generar_formulario: generar_formulario, proveedor_armar_paquete: armar_paquete, proveedor_simular_envio: simular_envio };
export type ToolName = keyof typeof herramientas;

export async function loadStoredMapping(ctx: Contexto, caso: string): Promise<Mapeo> {
  return mapeoSchema.parse(JSON.parse(await readFile(path.join(outRoot(ctx, caso), 'mapeo.json'), 'utf8')));
}
