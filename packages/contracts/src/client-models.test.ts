import { afterEach, expect, it, vi } from 'vitest';
import { populateModelOptions } from './client';

afterEach(() => vi.unstubAllGlobals());

it('lists only implemented production models', () => {
  class FakeOption {
    disabled = false;
    constructor(readonly text: string, readonly value: string) {}
  }
  vi.stubGlobal('Option', FakeOption);
  const options: FakeOption[] = [];
  populateModelOptions({ add: (option: FakeOption) => options.push(option) } as unknown as HTMLSelectElement);
  expect(options.map(option => [option.value, option.disabled, option.text])).toEqual([['gfs', false, 'GFS']]);
});
