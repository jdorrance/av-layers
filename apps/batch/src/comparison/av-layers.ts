/** Plan bounded point requests and bind their measurements to an archived v5 manifest. */
import { MAX_SAMPLE_POINTS, gridToGeographic, multiPointSampleResponseSchema, profileResponseSchema,
  type LayerId, type ManifestV5, type ProfileResponse } from '@av/contracts';
import { planSample } from '@av/forecast/sampler';
import type { ComparisonSample, Measurement } from './core.js';

interface Site { readonly id: string; readonly lat: number; readonly lon: number }
export interface AvSampleRequest {
  readonly url: string;
  readonly sites: readonly Site[];
  readonly frameIds: readonly string[];
  readonly layers: readonly LayerId[];
}

export function planAvSampleRequests(
  manifest: ManifestV5, sites: readonly Site[], options: { baseUrl: string; frames?: readonly string[] }
): AvSampleRequest[] {
  if (new Set(sites.map(site => site.id)).size !== sites.length || sites.some(site => !site.id
    || !Number.isFinite(site.lat) || Math.abs(site.lat) > 90 || !Number.isFinite(site.lon) || Math.abs(site.lon) > 180)) {
    throw new Error('Comparison sites require unique IDs and geographic coordinates');
  }
  const selected = new Set(options.frames ?? manifest.frames.map(frame => frame.id));
  const frames = manifest.frames.filter(frame => selected.has(frame.id));
  if (frames.length !== selected.size || (options.frames && selected.size !== options.frames.length)) throw new Error('Unknown or duplicate comparison frames');
  const limit = manifest.descriptors.maxSampleValues, requests: AvSampleRequest[] = [];
  for (let layerStart = 0; layerStart < manifest.layers.length; layerStart += limit) {
    const layers = manifest.layers.slice(layerStart, layerStart + limit);
    const frameLimit = Math.floor(limit / layers.length);
    for (let frameStart = 0; frameStart < frames.length; frameStart += frameLimit) {
      const frameIds = frames.slice(frameStart, frameStart + frameLimit).map(frame => frame.id);
      const pointLimit = Math.min(MAX_SAMPLE_POINTS, Math.floor(limit / (layers.length * frameIds.length)));
      for (let pointStart = 0; pointStart < sites.length; pointStart += pointLimit) {
        const points = sites.slice(pointStart, pointStart + pointLimit);
        const url = new URL(`/v1/models/${encodeURIComponent(manifest.model)}/runs/${encodeURIComponent(manifest.buildId)}/samples`, options.baseUrl);
        url.searchParams.set('points', points.map(point => `${point.lat},${point.lon}`).join(';'));
        url.searchParams.set('frame', frameIds.join(','));
        url.searchParams.set('layers', layers.join(','));
        requests.push({ url: url.href, sites: points, frameIds, layers });
      }
    }
  }
  return requests;
}

export function normalizeAvSamples(
  manifest: ManifestV5, request: AvSampleRequest, raw: unknown, sourceRef: string
): ComparisonSample[] {
  const response = multiPointSampleResponseSchema.parse(raw);
  if (response.model !== manifest.model || response.buildId !== manifest.buildId || response.expiresAt !== manifest.expiresAt
    || response.points.length !== request.sites.length) throw new Error('AV response differs from pinned build or point selection');
  const frames = new Map(manifest.frames.map(frame => [frame.id, frame]));
  return response.points.flatMap(({ index, sample }) => {
    const site = request.sites[index];
    if (sample.lat !== site.lat || sample.lon !== site.lon || sample.method.id !== manifest.method.id || sample.method.hash !== manifest.method.hash
      || sample.source.provider !== manifest.source.provider || sample.source.provenanceKey !== manifest.source.provenanceKey
      || sample.source.provenanceSha256 !== manifest.source.provenanceSha256) throw new Error('AV point identity or provenance differs from pinned build');
    if (sample.surfaces.length !== manifest.surfaces.length || sample.surfaces.some(surface => {
      const owner = manifest.surfaces.find(item => item.id === surface.id);
      return !owner || owner.kind !== surface.kind || !sameSelection(owner.layers, surface.layers)
        || owner.coverage.id !== surface.coverage.id || owner.coverage.hash !== surface.coverage.hash
        || owner.coverage.gridHash !== surface.coverage.gridHash || owner.coverage.maskKey !== surface.coverage.maskKey
        || owner.coverage.maxZoom !== surface.coverage.maxZoom;
    })) throw new Error('AV surfaces differ from pinned build');
    if (!sameSelection(sample.frames.map(frame => frame.id), request.frameIds)) throw new Error('AV response frame selection differs');
    return sample.frames.map(frame => {
      const expected = frames.get(frame.id);
      if (!expected || frame.validTime !== expected.validTime || frame.intervalStart !== expected.intervalStart || frame.intervalEnd !== expected.intervalEnd
        || !sameSelection(Object.keys(frame.layers), request.layers)) throw new Error('AV frame times or layer selection differ from pinned build');
      const values: Record<string, Measurement> = {};
      for (const [layer, value] of Object.entries(frame.layers)) {
        const descriptor = manifest.descriptors.layers[layer];
        if (!descriptor || !manifest.layers.includes(layer as LayerId)) throw new Error(`Unknown AV layer ${layer}`);
        if ((value.status === 'valid' && value.value === null)
          || (value.status === 'no-usable-lift' && (!descriptor.supportsNoLift || value.value !== descriptor.noLiftSampleValue))
          || ((value.status === 'unavailable' || value.status === 'outside-domain') && value.value !== null)) throw new Error(`AV value contradicts status for ${layer}`);
        values[layer] = {
          ...value, status: value.status === 'no-usable-lift' ? 'no-lift' : value.status,
          unit: descriptor.units === 'm MSL' || descriptor.units === 'm AGL' ? 'm' : descriptor.units,
          verticalReference: descriptor.verticalReference, definition: descriptor.quantity,
          methodId: descriptor.methodId, timeSupport: descriptor.timeSupport,
          ...(descriptor.timeSupport === 'valid-time' ? {} : { intervalStart: frame.intervalStart, intervalEnd: frame.intervalEnd })
        };
      }
      addBoundaryLayerWindSpeed(values);
      return { provider: 'av-layers', siteId: site.id, lat: site.lat, lon: site.lon,
        model: manifest.model, product: manifest.recipe.source.configurationId, cycle: manifest.cycle,
        buildId: manifest.buildId, validTime: frame.validTime, values, sourceRef };
    });
  });
}

function addBoundaryLayerWindSpeed(values: Record<string, Measurement>): void {
  const u = values['bl-mean-wind-u'], v = values['bl-mean-wind-v'];
  if (!u || !v) return;
  if (u.unit !== 'm/s' || v.unit !== u.unit || v.verticalReference !== u.verticalReference
    || v.surfaceId !== u.surfaceId || v.timeSupport !== u.timeSupport
    || v.intervalStart !== u.intervalStart || v.intervalEnd !== u.intervalEnd) throw new Error('AV boundary-layer wind components have different support');
  const status = u.status === 'outside-domain' || v.status === 'outside-domain' ? 'outside-domain'
    : u.status === 'valid' && v.status === 'valid' ? 'valid' : 'unavailable';
  values['derived-bl-mean-wind-speed'] = { ...u, status, value: status === 'valid' ? Math.hypot(u.value!, v.value!) : null,
    definition: 'magnitude-of-sampled-boundary-layer-mean-wind-components', methodId: 'vector-magnitude',
    interpolated: u.interpolated || v.interpolated, support: (u.support ?? 0) | (v.support ?? 0) };
}

function sameSelection(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every(value => expected.includes(value));
}

const PROFILE_FIELDS = {
  usableLiftTopV2M: ['native-usable-lift-v2-msl', 'm', 'MSL', 'thermal-top-msl'],
  hcritWxtoflyM: ['native-hcrit-wxtofly-msl', 'm', 'MSL', 'thermal-top-msl'],
  dryHcritM: ['native-dry-hcrit-msl', 'm', 'MSL', 'thermal-top-msl'],
  cuPotentialM: ['native-cu-potential-m', 'm', 'height-difference', 'thermal-top-msl'],
  odPotentialM: ['native-od-potential-m', 'm', 'height-difference', 'thermal-top-msl'],
  wind10mSpeedMps: ['native-wind-10m-speed', 'm/s', '10m-model-AGL', 'wind-10m-u'],
  wind10mDirDeg: ['native-wind-10m-direction', 'deg', '10m-model-AGL', 'wind-10m-u'],
  blMeanWindSpeedMps: ['native-bl-mean-wind-speed', 'm/s', 'native-boundary-layer', 'bl-mean-wind-u'],
  blMeanWindDirDeg: ['native-bl-mean-wind-direction', 'deg', 'native-boundary-layer', 'bl-mean-wind-u'],
  blTopWindSpeedMps: ['native-bl-top-wind-speed', 'm/s', 'native-boundary-layer-top', 'bl-mean-wind-u'],
  blTopWindDirDeg: ['native-bl-top-wind-direction', 'deg', 'native-boundary-layer-top', 'bl-mean-wind-u'],
  blWindShearMps: ['native-bl-wind-shear', 'm/s', 'native-boundary-layer', 'bl-mean-wind-u'],
  buoyancyShearRatio: ['native-buoyancy-shear-ratio', 'ratio', 'native-boundary-layer', 'thermal-top-msl'],
  cumulus: ['native-cumulus', 'boolean', 'native-column', 'thermal-top-msl'],
  overdeveloped: ['native-overdeveloped', 'boolean', 'native-column', 'thermal-top-msl'],
  cloudCapped: ['native-cloud-capped', 'boolean', 'native-column', 'thermal-top-msl'],
  mixedLayerLclM: ['native-mixed-layer-lcl-msl', 'm', 'MSL', 'thermal-top-msl'],
  effectiveCloudLimitM: ['native-effective-cloud-limit-msl', 'm', 'MSL', 'thermal-top-msl']
} as const satisfies Record<keyof ProfileResponse['frames'][number]['derived'], readonly [string, string, string, LayerId]>;

export interface AvProfileResult {
  samples: ComparisonSample[];
  cell: ProfileResponse['cell'];
  profiles: Pick<ProfileResponse['frames'][number], 'id' | 'validTime' | 'intervalStart' | 'intervalEnd' | 'profile'>[];
}

/** Preserve native columns and expose their additional diagnostics separately from point scalars. */
export function normalizeAvProfile(manifest: ManifestV5, site: Site, raw: unknown, sourceRef: string): AvProfileResult {
  const response = profileResponseSchema.parse(raw), native = manifest.surfaces.find(surface => surface.kind === 'native');
  if (!native?.profiles || response.model !== manifest.model || response.buildId !== manifest.buildId || response.cycle !== manifest.cycle
    || response.createdAt !== manifest.createdAt || response.expiresAt !== manifest.expiresAt || response.lat !== site.lat || response.lon !== site.lon
    || response.method.id !== manifest.method.id || response.method.hash !== manifest.method.hash
    || response.source.provider !== manifest.source.provider || response.source.provenanceKey !== manifest.source.provenanceKey
    || response.source.provenanceSha256 !== manifest.source.provenanceSha256) throw new Error('AV profile identity differs from pinned build');
  const cell = response.cell;
  if (cell) {
    const center = gridToGeographic(native.grid, cell.index % native.grid.width, Math.floor(cell.index / native.grid.width));
    const neighbors = planSample(native.grid, site.lat, site.lon)?.contributors;
    if (cell.surfaceId !== native.id || cell.index >= native.grid.width * native.grid.height || !center
      || Math.abs(center.lat - cell.lat) > 1e-6 || Math.abs(center.lon - cell.lon) > 1e-6
      || !neighbors?.some(neighbor => neighbor.index === cell.index && neighbor.weight > 0)) throw new Error('AV profile cell differs from native sampling grid');
  }
  if (new Set(response.frames.map(frame => frame.id)).size !== response.frames.length) throw new Error('AV profile repeats a frame');
  const frames = new Map(manifest.frames.map(frame => [frame.id, frame]));
  const samples = response.frames.map(frame => {
    const expected = frames.get(frame.id);
    if (!expected || frame.validTime !== expected.validTime || frame.intervalStart !== expected.intervalStart || frame.intervalEnd !== expected.intervalEnd
      || frame.profile.levels.length > native.profiles!.levelCount || (cell === null ? frame.profile.status !== 'outside-domain' : frame.profile.status === 'outside-domain')) {
      throw new Error('AV profile frame differs from pinned build');
    }
    for (const [layer, value] of Object.entries(frame.layers)) {
      if (!native.layers.includes(layer as LayerId) || value.surfaceId !== native.id || value.interpolated
        || value.status === 'no-usable-lift'
        || (cell === null ? value.status !== 'outside-domain' : value.status === 'outside-domain')
        || (value.status === 'valid' ? value.value === null : value.value !== null)) throw new Error('AV profile scalars differ from native cell');
    }
    if (cell === null && Object.values(frame.derived).some(value => value !== null)) throw new Error('Outside AV profile carries diagnostics');
    const values: Record<string, Measurement> = {};
    for (const key of Object.keys(PROFILE_FIELDS) as (keyof typeof PROFILE_FIELDS)[]) {
      const [id, unit, verticalReference, sourceLayer] = PROFILE_FIELDS[key], value = frame.derived[key];
      const timeSupport = manifest.descriptors.layers[sourceLayer]?.timeSupport;
      values[id] = { value: typeof value === 'boolean' ? Number(value) : value,
        status: cell === null ? 'outside-domain' : value === null ? 'unavailable' : 'valid', unit, verticalReference,
        definition: `profile.derived.${key}`, interpolated: false, surfaceId: native.id,
        ...(timeSupport === undefined ? {} : { timeSupport }),
        ...(timeSupport && timeSupport !== 'valid-time' ? { intervalStart: frame.intervalStart, intervalEnd: frame.intervalEnd } : {}) };
    }
    return { provider: 'av-layers', siteId: site.id, lat: site.lat, lon: site.lon, groundM: frame.profile.modelTerrainM,
      model: manifest.model, product: manifest.recipe.source.configurationId, cycle: manifest.cycle,
      buildId: manifest.buildId, validTime: frame.validTime, values, sourceRef };
  });
  return { samples, cell, profiles: response.frames.map(({ id, validTime, intervalStart, intervalEnd, profile }) => ({ id, validTime, intervalStart, intervalEnd, profile })) };
}
