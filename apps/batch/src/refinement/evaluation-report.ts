import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  getBit,
  paletteBinIndex,
  prepareGridGeometry,
  STATUS_MASK,
  STATUS_VALID,
  SUPPORT_MASK,
  type CoverageMask,
  type LayerId
} from '@av/contracts';
import type { GridField } from '@av/forecast';
import { localPath } from '../validate.js';
import { linearPercentile, transitionCounts, type TransitionCount } from './evaluation-input.js';

export type EvaluationPopulationSpec =
  | { readonly kind: 'whole-zone'; readonly name?: string }
  | {
      readonly kind: 'spherical-radius';
      readonly name?: string;
      readonly centerLat: number;
      readonly centerLon: number;
      readonly radiusM: number;
    };

export interface EvaluationPopulation {
  readonly name: string;
  readonly indices: Uint32Array;
  readonly count: number;
  readonly centerLat?: number;
  readonly centerLon?: number;
  readonly radiusM?: number;
  readonly earthRadiusM: number;
}

function greatCircleDistanceM(earthRadiusM: number, lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180, phi1 = lat1 * radians, phi2 = lat2 * radians;
  const deltaPhi = (lat2 - lat1) * radians, deltaLambda = (lon2 - lon1) * radians;
  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function selectEvaluationPopulation(mask: CoverageMask, spec: EvaluationPopulationSpec): EvaluationPopulation {
  const grid = mask.grid, geometry = prepareGridGeometry(grid), selected: number[] = [];
  if (spec.kind === 'spherical-radius') {
    if (!Number.isFinite(spec.centerLat) || spec.centerLat < -90 || spec.centerLat > 90
        || !Number.isFinite(spec.centerLon) || spec.centerLon < -180 || spec.centerLon > 180
        || !Number.isFinite(spec.radiusM) || spec.radiusM < 0) {
      throw new RangeError('Invalid spherical evaluation population');
    }
  }
  for (let index = 0; index < grid.width * grid.height; index++) {
    if (!getBit(mask.output, index)) continue;
    const point = geometry.gridToGeographic(index % grid.width, Math.floor(index / grid.width));
    if (!point) continue;
    if (spec.kind === 'spherical-radius'
        && greatCircleDistanceM(grid.earthRadiusM, spec.centerLat, spec.centerLon, point.lat, point.lon) > spec.radiusM) continue;
    selected.push(index);
  }
  const indices = Uint32Array.from(selected);
  return {
    name: spec.name ?? (spec.kind === 'whole-zone' ? 'whole-zone' : `radius-${spec.radiusM}m`),
    indices,
    count: indices.length,
    earthRadiusM: grid.earthRadiusM,
    ...(spec.kind === 'spherical-radius'
      ? { centerLat: spec.centerLat, centerLon: spec.centerLon, radiusM: spec.radiusM }
      : {})
  };
}

export interface StatusHistogramRow {
  readonly status: number;
  readonly left: number;
  readonly right: number;
  readonly both: number;
}

export interface PopulationFieldSummary {
  readonly population: Omit<EvaluationPopulation, 'indices'>;
  readonly commonValidCells: number;
  readonly leftValidOnly: number;
  readonly rightValidOnly: number;
  readonly neitherValid: number;
  readonly medianAbsoluteDifference: number | null;
  readonly p95AbsoluteDifference: number | null;
  readonly maximumAbsoluteDifference: number | null;
  readonly paletteAgreement: { readonly compared: number; readonly equal: number; readonly fraction: number | null };
  readonly statusHistogram: readonly StatusHistogramRow[];
  readonly statusTransitions: readonly TransitionCount[];
  readonly supportTransitions: readonly TransitionCount[];
}

export function summarizePopulationFields(
  population: EvaluationPopulation,
  left: GridField,
  right: GridField,
  layer: LayerId
): PopulationFieldSummary {
  if (!(left.values instanceof Float32Array) || !(left.flags instanceof Uint8Array)
      || !(right.values instanceof Float32Array) || !(right.flags instanceof Uint8Array)
      || left.values.length !== left.flags.length || right.values.length !== right.flags.length
      || left.values.length !== right.values.length) {
    throw new Error('Population fields differ in type, length or coverage');
  }
  type MutableStatusRow = { status: number; left: number; right: number; both: number };
  const statusCounts = new Map<number, MutableStatusRow>();
  const differences: number[] = [];
  let leftValidOnly = 0, rightValidOnly = 0, neitherValid = 0, paletteCompared = 0, paletteEqual = 0;
  for (const index of population.indices) {
    if (index >= left.flags.length) throw new RangeError('Population index exceeds field coverage');
    const leftStatus = left.flags[index]! & STATUS_MASK, rightStatus = right.flags[index]! & STATUS_MASK;
    const current = statusCounts.get(leftStatus) ?? { status: leftStatus, left: 0, right: 0, both: 0 };
    current.left++;
    statusCounts.set(leftStatus, current);
    if (leftStatus === rightStatus) {
      current.right++;
      current.both++;
    } else {
      const rightRow = statusCounts.get(rightStatus) ?? { status: rightStatus, left: 0, right: 0, both: 0 };
      rightRow.right++;
      statusCounts.set(rightStatus, rightRow);
    }
    const leftValid = leftStatus === STATUS_VALID && Number.isFinite(left.values[index]);
    const rightValid = rightStatus === STATUS_VALID && Number.isFinite(right.values[index]);
    if (leftValid && rightValid) {
      differences.push(Math.abs(left.values[index]! - right.values[index]!));
      paletteCompared++;
      if (paletteBinIndex(layer, left.values[index]!, left.flags[index]!) === paletteBinIndex(layer, right.values[index]!, right.flags[index]!)) paletteEqual++;
    } else if (leftValid) leftValidOnly++;
    else if (rightValid) rightValidOnly++;
    else neitherValid++;
  }
  differences.sort((a, b) => a - b);
  const { indices, ...populationMetadata } = population;
  return {
    population: populationMetadata,
    commonValidCells: differences.length,
    leftValidOnly,
    rightValidOnly,
    neitherValid,
    medianAbsoluteDifference: linearPercentile(differences, 0.5),
    p95AbsoluteDifference: linearPercentile(differences, 0.95),
    maximumAbsoluteDifference: differences.length ? differences[differences.length - 1]! : null,
    paletteAgreement: { compared: paletteCompared, equal: paletteEqual, fraction: paletteCompared ? paletteEqual / paletteCompared : null },
    statusHistogram: [...statusCounts.values()].sort((a, b) => a.status - b.status),
    statusTransitions: transitionCounts(left, right, STATUS_MASK, indices),
    supportTransitions: transitionCounts(left, right, SUPPORT_MASK, indices)
  };
}

export interface EvaluationRuntimeMetrics {
  readonly elapsedMs: number;
  readonly peakRssBytes: number;
  readonly render?: Readonly<Record<string, unknown>>;
}

export interface WriteEvaluationReportOptions<T> {
  readonly out: string;
  readonly buildId: string;
  readonly deterministic: T;
  readonly runtime: EvaluationRuntimeMetrics;
}

export interface WrittenEvaluationReport {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly deterministicSha256: string;
}

const buildIdPattern = /^\d{8}T\d{6}Z-[a-f0-9-]{36}$/;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export async function writeCompletedEvaluationReport<T>(options: WriteEvaluationReportOptions<T>): Promise<WrittenEvaluationReport> {
  if (!buildIdPattern.test(options.buildId)) throw new Error('Invalid evaluation build ID');
  if (!Number.isFinite(options.runtime.elapsedMs) || options.runtime.elapsedMs < 0
      || !Number.isSafeInteger(options.runtime.peakRssBytes) || options.runtime.peakRssBytes < 0) {
    throw new RangeError('Invalid evaluation runtime metrics');
  }
  const path = localPath(options.out, `${options.buildId}/report.json`);
  const deterministic = stableJson(options.deterministic);
  const bytes = Buffer.from(stableJson({ version: 1, buildId: options.buildId, deterministic: JSON.parse(deterministic), runtime: options.runtime }));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx');
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Completed evaluation report already exists');
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    deterministicSha256: createHash('sha256').update(deterministic).digest('hex')
  };
}
