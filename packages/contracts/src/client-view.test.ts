import { expect, it } from 'vitest';
import { fixtureBuild, fixtureManifest } from '../../../tests/forecast-fixture';
import { buildDiagnosticRows } from './client-view';

it('shows the actual horizon for irregular frames in channel order', () => {
  const frames = fixtureManifest().frames;
  const build = fixtureBuild({ frames: [frames[2], frames[0], frames.at(-1)!] });
  expect(buildDiagnosticRows(build).find(([label]) => label === 'Horizon')).toEqual([
    'Horizon', `${frames[0].validTime} → ${frames.at(-1)!.validTime}`
  ]);
  expect(build.manifest.frames.map(frame => frame.id)).toEqual([frames[2].id, frames[0].id, frames.at(-1)!.id]);
});
