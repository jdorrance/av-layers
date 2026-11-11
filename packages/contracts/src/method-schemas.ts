import z from 'zod';

/** Wire snapshots describe their own inputs and parameters. Do not compare a
 * retained build with today's constants or require its old executable kernel.
 */
export const methodIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const inputIdSchema = z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/);
const parameterKeySchema = z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/);
export const normalizedInputSchema = z.object({
  id: inputIdSchema, quantity: z.string().min(1).max(80), units: z.string().min(1).max(24),
  dimensions: z.enum(['cell', 'level', 'level-cell']), verticalReference: z.string().min(1).max(80),
  timeSupport: z.enum(['static', 'valid-time', 'interval-mean', 'interval-maximum']), missingness: z.enum(['explicit-cell-mask', 'all-levels-required'])
}).strict();

export const methodDescriptorSchema = z.object({
  id: methodIdSchema,
  requiredInputs: z.array(inputIdSchema).min(1).max(16),
  inputs: z.record(inputIdSchema, normalizedInputSchema),
  outputs: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1).max(16),
  spatialSupport: z.enum(['column', 'bilinear-neighborhood']),
  parameters: z.record(parameterKeySchema, z.number().finite()),
  caveats: z.array(z.string().min(1).max(512)).min(1).max(8)
}).strict().superRefine((method, ctx) => {
  const required = new Set(method.requiredInputs), definitions = Object.entries(method.inputs);
  if (required.size !== method.requiredInputs.length || definitions.length !== required.size
      || definitions.some(([id, input]) => !required.has(id) || input.id !== id)) {
    ctx.addIssue({ code: 'custom', path: ['requiredInputs'], message: 'Method input dependencies are incomplete or duplicated' });
  }
  if (new Set(method.outputs).size !== method.outputs.length) ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'Method outputs are duplicated' });
  if (Object.keys(method.parameters).length > 32) ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'Method parameter budget exceeded' });
});
