import { afterEach, expect, it, vi } from 'vitest';
import { populateModelOptions } from './models';

afterEach(() => vi.unstubAllGlobals());

it('exposes the regional model names as unavailable rather than working choices', () => {
  class FakeOption {
    disabled = false;
    constructor(readonly text: string, readonly value: string) {}
  }
  vi.stubGlobal('Option', FakeOption);
  const options: FakeOption[] = [];
  populateModelOptions({ add: (option: FakeOption) => options.push(option) } as unknown as HTMLSelectElement);
  expect(options.map(option => [option.value, option.disabled, option.text])).toEqual([
    ['gfs', false, 'gfs'],
    ['hrrr', true, 'hrrr (unavailable: regional coverage not implemented)'],
    ['icon-armenia', true, 'icon-armenia (unavailable: regional coverage not implemented)']
  ]);
});
