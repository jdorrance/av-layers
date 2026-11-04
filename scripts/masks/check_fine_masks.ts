import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalGridJson, sparseCoverageDescriptorSchema } from '../../packages/contracts/src/coverage.js';
import { encodeSparseCoverage } from '../../packages/contracts/src/sparse-coverage.js';
import { readSparseCoverage } from '../../apps/batch/src/coverage.js';

const [root, hash] = process.argv.slice(2);
const { descriptor, mask } = await readSparseCoverage(root, hash);
sparseCoverageDescriptorSchema.parse(descriptor);
assert.equal(createHash('sha256').update(canonicalGridJson(descriptor.grid)).digest('hex'), descriptor.gridHash);
assert.deepEqual(Buffer.from(encodeSparseCoverage(mask.coverage)), await readFile(join(root, 'coverage', hash, 'sparse.bin')));
