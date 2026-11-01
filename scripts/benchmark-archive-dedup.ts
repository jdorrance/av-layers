import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { expectedTiles } from '@av/contracts';
import { openArchive } from '../apps/batch/src/archive-reader.js';
import { loadCoverage, sha256 } from '../apps/batch/src/validate.js';

const { values } = parseArgs({ options: { help: { type: 'boolean' }, input: { type: 'string', multiple: true }, output: { type: 'string' } } });
if (values.help) { console.log('Usage: --input ARCHIVE [--input ARCHIVE] --output RECEIPT'); process.exit(0); }
if (!values.input?.length || !values.output) throw new Error('Usage: --input ARCHIVE [--input ARCHIVE] --output RECEIPT');
const binary = resolve('.tools/pmtiles'), temporary = await mkdtemp(join(tmpdir(), 'av-dedup-bench-'));
const mask = await loadCoverage(), tiles = Array.from({ length: mask.maxZoom + 1 }, (_, z) => expectedTiles(mask, z)).flat();
const corpus: { source: string; mbtiles: string; hashes: string[] }[] = [], runs: unknown[] = [];
try {
  for (const [index, source] of values.input.entries()) {
    const mbtiles = join(temporary, `${index}.mbtiles`), db = new DatabaseSync(mbtiles), archive = await openArchive(source), hashes = [];
    try {
      db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles(zoom_level,tile_column,tile_row); BEGIN');
      const metadata = db.prepare('INSERT INTO metadata VALUES (?,?)');
      for (const [key, value] of Object.entries({ name: String(index), format: 'webp', minzoom: '0', maxzoom: String(mask.maxZoom), bounds: '-180,-85.051129,180,85.051129' })) metadata.run(key, value);
      const insert = db.prepare('INSERT INTO tiles VALUES (?,?,?,?)');
      for (const tile of tiles) {
        const data = await archive.reader.getZxy(tile.z, tile.x, tile.y);
        if (!data) throw new Error('Source archive missing expected tile');
        const bytes = new Uint8Array(data.data); hashes.push(sha256(bytes));
        insert.run(tile.z, tile.x, 2 ** tile.z - 1 - tile.y, bytes);
      }
      db.exec('COMMIT');
    } finally { db.close(); await archive.close(); }
    corpus.push({ source, mbtiles, hashes });
  }
  for (let repetition = 0; repetition <= 5; repetition++) for (const dedup of (repetition % 2 ? [true, false] : [false, true])) {
    const started = performance.now(); let bytes = 0, tileContents = 0;
    const outputs = corpus.map((_, index) => join(temporary, `${repetition}-${dedup}-${index}.pmtiles`));
    for (let i = 0; i < corpus.length; i++) {
      execFileSync(binary, ['convert', ...(dedup ? [] : ['--no-deduplication']), corpus[i].mbtiles, outputs[i]], { stdio: 'pipe' });
      execFileSync(binary, ['verify', outputs[i]], { stdio: 'pipe' });
      bytes += (await stat(outputs[i])).size;
    }
    const elapsedMs = performance.now() - started;
    for (let i = 0; i < corpus.length; i++) {
      const archive = await openArchive(outputs[i]);
      try {
        const header = await archive.reader.getHeader();
        if (header.numAddressedTiles !== tiles.length) throw new Error('Converted address count differs');
        tileContents += header.numTileContents;
        for (const [j, tile] of tiles.entries()) {
          const data = await archive.reader.getZxy(tile.z, tile.x, tile.y);
          if (!data || sha256(new Uint8Array(data.data)) !== corpus[i].hashes[j]) throw new Error('Converted tile payload differs');
        }
      } finally { await archive.close(); await rm(outputs[i]); }
    }
    const run = { repetition, state: repetition ? 'warm-process' : 'cold-process', dedup, elapsedMs, bytes, tileContents, addressedTiles: tiles.length * corpus.length, exactPayloads: true };
    runs.push(run); console.error(JSON.stringify(run));
  }
  await writeFile(values.output, JSON.stringify({ kind: 'official-pmtiles-dedup', inputs: values.input, runs, note: 'Elapsed covers official conversion+verification; independent every-address encoded-payload equality occurs outside timings. OS caches not purged; no parent-RSS claim for child converter processes.' }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
