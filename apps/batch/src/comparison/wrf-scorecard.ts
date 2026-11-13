/** Paired observation errors and usable-lift events on collocated, matching time support. */
import z from 'zod';
import type { ComparisonSample, Measurement } from './core.js';

const observationSchema = z.strictObject({
  siteId: z.string().min(1), lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180),
  validTime: z.iso.datetime(), parameter: z.string().min(1), status: z.enum(['valid', 'no-lift']),
  value: z.number().finite().nullable(), unit: z.string().min(1), verticalReference: z.string().min(1),
  timeSupport: z.enum(['valid-time', 'interval-mean', 'interval-flux-endpoint-profile']),
  intervalStart: z.iso.datetime().optional(), intervalEnd: z.iso.datetime().optional(), source: z.string().min(1)
}).superRefine((value, ctx) => {
  if ((value.status === 'valid') !== (value.value !== null)
    || value.status === 'no-lift' && !value.parameter.startsWith('usable-lift-')) {
    ctx.addIssue({ code: 'custom', message: 'Observation status contradicts its parameter or value' });
  }
  if (value.timeSupport === 'valid-time') {
    if (value.intervalStart || value.intervalEnd) ctx.addIssue({ code: 'custom', message: 'Endpoint observations omit averaging windows' });
  } else if (!value.intervalStart || !value.intervalEnd || Date.parse(value.intervalStart) >= Date.parse(value.intervalEnd)
    || Date.parse(value.intervalEnd) !== Date.parse(value.validTime)) {
    ctx.addIssue({ code: 'custom', message: 'Observation window must be positive and end at valid time' });
  }
});
export const observationsSchema = z.array(observationSchema).min(1).max(100_000);
export type Observation = z.infer<typeof observationSchema>;
const time = (value: string) => new Date(value).toISOString();
const key = (site: string, valid: string) => JSON.stringify([site, time(valid)]);

function comparable(value: Measurement | undefined, observation: Observation): value is Measurement {
  if (!value) return false;
  if (value.unit !== observation.unit || value.verticalReference !== observation.verticalReference) {
    throw new Error('Observation units or vertical reference differ from forecast');
  }
  if (value.timeSupport !== observation.timeSupport) return false;
  return value.timeSupport === 'valid-time' || !!value.intervalStart && !!value.intervalEnd
    && time(observation.intervalStart!) === time(value.intervalStart) && time(observation.intervalEnd!) === time(value.intervalEnd);
}

function metrics(errors: number[]) {
  const n = errors.length, sum = (f: (e: number) => number) => errors.reduce((total, e) => total + f(e), 0);
  const result = { n, bias: n ? sum(e => e) / n : null, mae: n ? sum(Math.abs) / n : null,
    rmse: n ? Math.sqrt(sum(e => e * e) / n) : null };
  if (Object.values(result).some(value => value !== null && !Number.isFinite(value))) throw new Error('Non-finite observation score');
  return result;
}

export function observationScorecard(samples: ComparisonSample[], models: string[], baseline: string, raw: unknown) {
  const observations = observationsSchema.parse(raw), seen = new Set<string>();
  if (new Set(models).size !== models.length || !models.includes(baseline)) throw new Error('Unique models and baseline required');
  const indexes = new Map(models.map(model => [model, new Map<string, ComparisonSample>()]));
  const sites = new Map<string, { lat: number; lon: number }>(), parameters = new Set<string>();
  for (const sample of samples) {
    const index = indexes.get(sample.model), id = key(sample.siteId, sample.validTime);
    if (!index) throw new Error('Unexpected forecast model');
    if (index.has(id)) throw new Error('Duplicate forecast site/time');
    if (sample.lat === undefined || sample.lon === undefined) throw new Error('Missing forecast coordinates');
    const site = sites.get(sample.siteId);
    if (site && (site.lat !== sample.lat || site.lon !== sample.lon)) throw new Error('Inconsistent forecast coordinates');
    sites.set(sample.siteId, { lat: sample.lat, lon: sample.lon });
    Object.keys(sample.values).forEach(parameter => parameters.add(parameter));
    index.set(id, sample);
  }
  const groups = new Map<string, { siteId: string; parameter: string; unit: string; verticalReference: string;
    observations: number; supportExcluded: number; statusCounts: Record<string, number>; errors: Map<string, number[]>;
    events: Record<string, { hits: number; misses: number; falseAlarms: number; correctNegatives: number }> }>();
  for (const observation of observations) {
    const site = sites.get(observation.siteId);
    if (!site || site.lat !== observation.lat || site.lon !== observation.lon) throw new Error('Observation coordinates differ from comparison site');
    if (!parameters.has(observation.parameter)) throw new Error('Unknown observation parameter');
    const id = key(observation.siteId, observation.validTime), identity = JSON.stringify([id, observation.parameter]);
    if (seen.has(identity)) throw new Error('Duplicate observation');
    seen.add(identity);
    const groupKey = JSON.stringify([observation.siteId, observation.parameter, observation.unit, observation.verticalReference]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { siteId: observation.siteId, parameter: observation.parameter, unit: observation.unit,
        verticalReference: observation.verticalReference, observations: 0, supportExcluded: 0, statusCounts: {},
        errors: new Map(models.map(model => [model, []])), events: Object.fromEntries(models.map(model =>
          [model, { hits: 0, misses: 0, falseAlarms: 0, correctNegatives: 0 }])) };
      groups.set(groupKey, group);
    }
    group.observations++;
    const values = models.map(model => indexes.get(model)!.get(id)?.values[observation.parameter]);
    values.forEach((value, i) => {
      const status = `${models[i]}:${value?.status ?? 'missing'}`;
      group!.statusCounts[status] = (group!.statusCounts[status] ?? 0) + 1;
    });
    const support = values.map(value => comparable(value, observation));
    if (support.some(value => !value)) { group.supportExcluded++; continue; }
    if (observation.parameter.startsWith('usable-lift-') && values.every(value => value?.status === 'valid' || value?.status === 'no-lift')) {
      values.forEach((value, i) => {
        const event = observation.status === 'valid' ? value!.status === 'valid' ? 'hits' : 'misses'
          : value!.status === 'valid' ? 'falseAlarms' : 'correctNegatives';
        group!.events[models[i]][event]++;
      });
    }
    if (observation.value !== null && values.every(value => value?.status === 'valid' && value.value !== null)) {
      values.forEach((value, i) => group!.errors.get(models[i])!.push(value!.value! - observation.value!));
    }
  }
  return { baseline, observationCount: observations.length, groups: [...groups.values()].map(({ errors, ...group }) => {
    const scores = Object.fromEntries([...errors].map(([model, values]) => [model, metrics(values)])), base = scores[baseline].mae;
    const maeSkill = Object.fromEntries(models.map(model => [model,
      base !== null && base > 0 && scores[model].mae !== null ? 1 - scores[model].mae! / base : null]));
    if (Object.values(maeSkill).some(value => value !== null && !Number.isFinite(value))) throw new Error('Non-finite observation skill');
    return { ...group, scores, maeSkill };
  }) };
}
