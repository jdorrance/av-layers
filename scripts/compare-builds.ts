import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { openArchive, Compression, TileType } from '../apps/batch/src/archive-reader.js';
import { expectedTiles } from '@av/contracts';
import { loadCoverage, sha256 } from '../apps/batch/src/validate.js';
import { decodeWebp } from '../apps/batch/src/webp.js';

interface ComparisonManifest {
  cycle: string; frames: unknown[]; layers: string[]; coverage: { maxZoom: number };
  artifacts: { frame: string; layer: string; tilesKey: string }[];
  samples: { key: string; sha256: string; bytes: number; storedCells: number; channelCount: number; blockSize: number; format: string };
  source: { provenanceKey: string; provenanceSha256: string };
}
const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'baseline-root': { type: 'string' }, 'baseline-manifest': { type: 'string' }, 'candidate-root': { type: 'string' }, 'candidate-manifest': { type: 'string' }, output: { type: 'string' } } });
if (values.help) { console.log('Usage: --baseline-root PATH --baseline-manifest FILE --candidate-root PATH --candidate-manifest FILE --output FILE'); process.exit(0); }
if ([values['baseline-root'], values['baseline-manifest'], values['candidate-root'], values['candidate-manifest'], values.output].filter(Boolean).length !== 5) throw new Error('Usage: --baseline-root PATH --baseline-manifest FILE --candidate-root PATH --candidate-manifest FILE --output FILE');
const started = performance.now();
const pathFor = (root: string, key: string) => { const path = resolve(root, key); if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Unsafe build key ${key}`); return path; };
function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'capturedAt').sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, normalize(val)])) : item;
  return JSON.stringify(normalize(value));
}
const manifestBytes = await Promise.all([values['baseline-manifest']!, values['candidate-manifest']!].map(path => readFile(path)));
const [baseline, candidate] = manifestBytes.map(bytes => JSON.parse(bytes.toString('utf8')) as ComparisonManifest);
for (const field of ['cycle', 'frames', 'layers'] as const) if (canonical(baseline[field]) !== canonical(candidate[field])) throw new Error(`Build ${field} differ`);
for (const key of ['bytes', 'storedCells', 'channelCount', 'blockSize', 'format'] as const) if (baseline.samples[key] !== candidate.samples[key]) throw new Error(`Sample layout ${key} differs`);
const sampleHandles = await Promise.all([open(pathFor(values['baseline-root']!, baseline.samples.key), 'r'), open(pathFor(values['candidate-root']!, candidate.samples.key), 'r')]);
const sampleHashes = [createHash('sha256'), createHash('sha256')], chunks = [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024)];
try {
  const sizes = await Promise.all(sampleHandles.map(async file => (await file.stat()).size));
  if (sizes.some(size => size !== baseline.samples.bytes)) throw new Error('Sample file length differs');
  for (let offset = 0; offset < baseline.samples.bytes; offset += chunks[0].length) {
    const length = Math.min(chunks[0].length, baseline.samples.bytes - offset);
    const reads = await Promise.all(sampleHandles.map((file, i) => file.read(chunks[i], 0, length, offset)));
    if (reads.some(result => result.bytesRead !== length)) throw new Error('Short sample file read');
    if (!chunks[0].subarray(0, length).equals(chunks[1].subarray(0, length))) {
      let differing = 0; while (chunks[0][differing] === chunks[1][differing]) differing++;
      throw new Error(`Sample byte mismatch at offset ${offset + differing}`);
    }
    for (let i = 0; i < 2; i++) sampleHashes[i].update(chunks[i].subarray(0, length));
  }
} finally { await Promise.all(sampleHandles.map(file => file.close())); }
const sampleSha256 = sampleHashes.map(hash => hash.digest('hex'));
if (sampleSha256[0] !== baseline.samples.sha256 || sampleSha256[1] !== candidate.samples.sha256) throw new Error('Sample manifest digest mismatch');
const provenance = await Promise.all([[values['baseline-root']!, baseline], [values['candidate-root']!, candidate]].map(async ([root, manifest]) => {
  const source = (manifest as ComparisonManifest).source, bytes = await readFile(pathFor(root as string, source.provenanceKey));
  if (sha256(bytes) !== source.provenanceSha256) throw new Error('Provenance digest mismatch');
  return JSON.parse(bytes.toString('utf8')) as { frames: unknown[] };
}));
if (!Array.isArray(provenance[0].frames) || provenance[0].frames.length !== baseline.frames.length || canonical(provenance[0].frames) !== canonical(provenance[1].frames)) throw new Error('Source frame provenance differs after excluding capture timestamps');
const mask = await loadCoverage();
if (baseline.coverage.maxZoom !== mask.maxZoom || candidate.coverage.maxZoom !== mask.maxZoom) throw new Error('Comparison coverage zoom differs');
const tiles = Array.from({ length: mask.maxZoom + 1 }, (_, z) => expectedTiles(mask, z)).flat();
const artifactKey = (artifact: ComparisonManifest['artifacts'][number]) => `${artifact.frame}/${artifact.layer}`;
const candidateArtifacts = new Map(candidate.artifacts.map(artifact => [artifactKey(artifact), artifact]));
const expectedKeys = new Set(baseline.frames.flatMap(frame => baseline.layers.map(layer => `${(frame as { id: string }).id}/${layer}`)));
if (expectedKeys.size !== baseline.frames.length * baseline.layers.length || candidateArtifacts.size !== expectedKeys.size || baseline.artifacts.length !== expectedKeys.size || new Set(baseline.artifacts.map(artifactKey)).size !== expectedKeys.size || baseline.artifacts.some(artifact => !expectedKeys.has(artifactKey(artifact))) || candidate.artifacts.some(artifact => !expectedKeys.has(artifactKey(artifact))) || candidateArtifacts.size !== candidate.artifacts.length) throw new Error('Incomplete or different artifact set');
const decodedHashes = new Map<string, Promise<string>>();
let uniquePayloadDecodes = 0;
async function rgbaHash(bytes: Uint8Array): Promise<string> {
  const key = sha256(bytes), cached = decodedHashes.get(key);
  if (cached) { decodedHashes.delete(key); decodedHashes.set(key, cached); return cached; }
  const digest = (async () => {
    const decoded = await decodeWebp(bytes);
    if (decoded.width !== 256 || decoded.height !== 256) throw new Error('Unexpected tile dimensions');
    uniquePayloadDecodes++;
    return sha256(decoded.data);
  })();
  decodedHashes.set(key, digest);
  if (decodedHashes.size > 2048) decodedHashes.delete(decodedHashes.keys().next().value!);
  return digest;
}
const artifactReceipts = [];
for (const previous of baseline.artifacts) {
  const key = artifactKey(previous), next = candidateArtifacts.get(key);
  if (!next) throw new Error(`Missing candidate artifact ${key}`);
  const readers = await Promise.all([openArchive(pathFor(values['baseline-root']!, previous.tilesKey)), openArchive(pathFor(values['candidate-root']!, next.tilesKey))]);
  const digest = createHash('sha256');
  let encodedIdentical = 0;
  try {
    for (const { reader } of readers) {
      const header = await reader.getHeader();
      if (header.tileType !== TileType.Webp || header.tileCompression !== Compression.None || header.minZoom !== 0 || header.maxZoom !== mask.maxZoom || header.numAddressedTiles !== tiles.length) throw new Error(`Archive address/header mismatch ${key}`);
    }
    for (const tile of tiles) {
      const pair = await Promise.all(readers.map(({ reader }) => reader.getZxy(tile.z, tile.x, tile.y)));
      if (!pair[0] || !pair[1]) throw new Error(`Missing tile ${key}/${tile.z}/${tile.x}/${tile.y}`);
      const bytes = pair.map(item => new Uint8Array(item!.data));
      if (Buffer.from(bytes[0]).equals(Buffer.from(bytes[1]))) encodedIdentical++;
      const rgba = await Promise.all(bytes.map(rgbaHash));
      if (rgba[0] !== rgba[1]) throw new Error(`Decoded RGBA mismatch ${key}/${tile.z}/${tile.x}/${tile.y}`);
      digest.update(`${tile.z}/${tile.x}/${tile.y}:${rgba[0]}\n`);
    }
  } finally { await Promise.all(readers.map(reader => reader.close())); }
  artifactReceipts.push({ key, tiles: tiles.length, encodedIdentical, orderedRgbaSha256: digest.digest('hex') });
  console.error(JSON.stringify(artifactReceipts.at(-1)));
}
const receipt = { version: 1, passed: true, baselineManifest: resolve(values['baseline-manifest']!), baselineManifestSha256: sha256(manifestBytes[0]), candidateManifest: resolve(values['candidate-manifest']!), candidateManifestSha256: sha256(manifestBytes[1]), elapsedMs: performance.now() - started, samples: { byteExact: true, bytes: baseline.samples.bytes, sha256: sampleSha256[0] }, sourceFrames: { equalExcludingCapturedAt: true, count: provenance[0].frames.length, sha256: sha256(Buffer.from(canonical(provenance[0].frames))) }, archivePolicy: 'Compare every expected address, exact dimensions and decoded RGBA SHA256; archive ordering and compressed bytes may differ. Decoded content digest cache is bounded to 2,048 entries.', totalTilesCompared: tiles.length * artifactReceipts.length, uniquePayloadDecodes, artifacts: artifactReceipts };
await mkdir(dirname(resolve(values.output!)), { recursive: true });
await writeFile(values.output!, JSON.stringify(receipt, null, 2));
