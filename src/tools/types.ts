import { z } from 'zod';

export const campoSchema = z.object({
  etiqueta: z.string(),
  obligatorio: z.boolean().optional(),
  hoja: z.string().optional(),
  celda_etiqueta: z.string().optional(),
  celda_valor: z.string().optional()
}).strict();

export const itemSchema = z.object({
  etiqueta: z.string(),
  estado: z.enum(['lleno', 'faltante', 'requiere_confirmacion']),
  valor: z.union([z.string(), z.number(), z.boolean()]).optional(),
  fuente: z.string().optional(),
  confianza: z.number().min(0).max(1),
  nota: z.string().optional()
}).strict();

export const mapeoSchema = z.object({
  llenos: z.array(itemSchema),
  faltantes: z.array(itemSchema),
  requiere_confirmacion: z.array(itemSchema)
}).strict();

export type Campo = z.infer<typeof campoSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Mapeo = z.infer<typeof mapeoSchema>;
export type Contexto = { directory: string; sessionId: string };
