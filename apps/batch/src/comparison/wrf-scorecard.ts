/** Observation errors on the common available site/time support of all selected forecasts. */
import z from 'zod';
import type { ComparisonSample, Measurement } from './core.js';

const observationSchema = z.strictObject({
  siteId: z.string().min(1), validTime: z.iso.datetime(), parameter: z.string().min(1),
  value: z.number().finite(), unit: z.string().min(1), verticalReference: z.string().min(1),
  intervalStart: z.iso.datetime().optional(), intervalEnd: z.iso.datetime().optional(),
  source: z.string().min(1)
});
export const observationsSchema = z.array(observationSchema).min(1).max(100_000);
export type Observation = z.infer<typeof observationSchema>;
const time = (value: string) => new Date(value).toISOString();
const key = (site: string, valid: string) => JSON.stringify([site, time(valid)]);

function supported(value: Measurement | undefined, observation: Observation): value is Measurement & { value: number } {
  if (!value || value.status !== 'valid' || value.value === null) return false;
  if (value.unit !== observation.unit || value.verticalReference !== observation.verticalReference) {
    throw new Error('Observation units or vertical reference differ from forecast');
  }
  if (value.timeSupport !== 'valid-time' && (!observation.intervalStart || !observation.intervalEnd
    || !value.intervalStart || !value.intervalEnd || time(observation.intervalStart) !== time(value.intervalStart)
    || time(observation.intervalEnd) !== time(value.intervalEnd))) return false;
  return true;
}

function metrics(errors: number[]) {
  const n = errors.length, sum = (f: (e: number) => number) => errors.reduce((total, e) => total + f(e), 0);
  return { n, bias: n ? sum(e => e) / n : null, mae: n ? sum(Math.abs) / n : null,
    rmse: n ? Math.sqrt(sum(e => e * e) / n) : null };
}

export function observationScorecard(samples: ComparisonSample[], models: string[], baseline: string, raw: unknown) {
  const observations = observationsSchema.parse(raw), seen = new Set<string>();
  if (new Set(models).size !== models.length || !models.includes(baseline)) throw new Error('Unique models and baseline required');
  const indexes = new Map(models.map(model => [model, new Map<string, ComparisonSample>()]));
  for (const sample of samples) {
    const index = indexes.get(sample.model);
    if (!index) throw new Error('Unexpected forecast model');
    const id = key(sample.siteId, sample.validTime);
    if (index.has(id)) throw new Error('Duplicate forecast site/time');
    index.set(id, sample);
  }
  const groups = new Map<string, { siteId: string; parameter: string; unit: string; verticalReference: string;
    observations: number; statusCounts: Record<string, number>; errors: Map<string, number[]> }>();
  for (const observation of observations) {
    const id = key(observation.siteId, observation.validTime), identity = JSON.stringify([id, observation.parameter]);
    if (seen.has(identity)) throw new Error('Duplicate observation');
    seen.add(identity);
    const groupKey = JSON.stringify([observation.siteId, observation.parameter, observation.unit, observation.verticalReference]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { siteId: observation.siteId, parameter: observation.parameter, unit: observation.unit,
        verticalReference: observation.verticalReference, observations: 0, statusCounts: {}, errors: new Map(models.map(model => [model, []])) };
      groups.set(groupKey, group);
    }
    group.observations++;
    const values = models.map(model => indexes.get(model)!.get(id)?.values[observation.parameter]);
    values.forEach((value, i) => {
      const status = `${models[i]}:${value?.status ?? 'missing'}`;
      group!.statusCounts[status] = (group!.statusCounts[status] ?? 0) + 1;
    });
    if (values.every(value => supported(value, observation))) values.forEach((value, i) => group!.errors.get(models[i])!.push(value.value - observation.value));
  }
  return { baseline, observationCount: observations.length, groups: [...groups.values()].map(({ errors, ...group }) => {
    const scores = Object.fromEntries([...errors].map(([model, values]) => [model, metrics(values)])), base = scores[baseline].mae;
    return { ...group, scores, maeSkill: Object.fromEntries(models.map(model => [model,
      base !== null && base > 0 && scores[model].mae !== null ? 1 - scores[model].mae! / base : null])) };
  }) };
}
