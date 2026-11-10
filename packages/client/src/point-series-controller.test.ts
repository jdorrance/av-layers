import { expect, it, vi } from 'vitest';
import { retainedPointBuild } from '../../../tests/client-point-fixture.ts';
import type { PointSeries, PointSeriesLoader } from './client-types.ts';
import { PointSeriesController } from './point-series-controller.ts';

const point = { lat: 40, lon: -100 };
const series: PointSeries = { layers: [], frames: [] };
const view = () => ({ onLoading: vi.fn(), onProgress: vi.fn(), onError: vi.fn() });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

it('keeps the selected hour across horizons and drops callbacks from replaced and closed requests', async () => {
  const build = retainedPointBuild();
  const [first, second] = build.manifest.frames;
  const later = build.manifest.frames.at(-1)!;
  const day = deferred<PointSeries>(), forecast = deferred<PointSeries>();
  const load = vi.fn<PointSeriesLoader['load']>().mockReturnValueOnce(day.promise).mockReturnValueOnce(forecast.promise);
  const dispose = vi.fn();
  const controller = new PointSeriesController({ pointSeries: () => ({ load, dispose }) });
  controller.open(build, point);
  const opened = controller.current!, oldView = view(), newView = view();
  const loadingDay = controller.load('day', first.id, oldView);
  expect(controller.pending).toBe(true);
  expect(controller.selectFrame(opened, later.id)).toBe(false);
  controller.followMapFrame(second.id);

  const loadingForecast = controller.load('forecast', first.id, newView);
  const [, daySignal, dayOptions] = load.mock.calls[0];
  const [, forecastSignal, forecastOptions] = load.mock.calls[1];
  expect(daySignal?.aborted).toBe(true);
  expect(forecastOptions?.frameId).toBe(second.id);
  expect(controller.selectFrame(opened, later.id)).toBe(true);
  dayOptions?.onProgress?.(series, 24, true);
  day.reject(new Error('Old request failed'));
  await loadingDay;
  expect(oldView.onProgress).not.toHaveBeenCalled();
  expect(oldView.onError).not.toHaveBeenCalled();

  controller.close();
  expect(forecastSignal?.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  controller.open(build, point);
  expect(controller.selectFrame(opened, first.id)).toBe(false);
  forecastOptions?.onProgress?.(series, 40, false);
  forecast.resolve(series);
  await loadingForecast;
  expect(newView.onProgress).not.toHaveBeenCalled();
  expect(controller.frameId).toBeNull();
  expect(controller.pending).toBe(false);
  controller.close();
});

it('renders the latest available progress when the lazy chart is ready', async () => {
  const chart = deferred<void>(), adapter = view();
  const final: PointSeries = { layers: ['precip-rate'], frames: [] };
  const load: PointSeriesLoader['load'] = async (_horizon, _signal, options) => {
    options?.onProgress?.(series, 2, true);
    options?.onProgress?.(final, 2, false);
    return final;
  };
  const controller = new PointSeriesController({ pointSeries: () => ({ load, dispose() {} }) });
  controller.open(retainedPointBuild(), point);
  const pending = controller.load('day', null, { ...adapter, prepare: () => chart.promise });
  expect(adapter.onProgress).not.toHaveBeenCalled();
  chart.resolve();
  await pending;
  expect(adapter.onProgress).toHaveBeenCalledExactlyOnceWith(final, 2, false);
  expect(controller.pending).toBe(false);
});

it('reports a chart import failure and cancels its point reads', async () => {
  const adapter = view(), chart = deferred<void>();
  const load = vi.fn<PointSeriesLoader['load']>((_horizon, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const controller = new PointSeriesController({ pointSeries: () => ({ load, dispose() {} }) });
  controller.open(retainedPointBuild(), point);
  const pending = controller.load('day', null, { ...adapter, prepare: () => chart.promise });
  chart.reject(new Error('Chart unavailable'));
  await pending;
  expect(load.mock.calls[0][1]?.aborted).toBe(true);
  expect(adapter.onError).toHaveBeenCalledExactlyOnceWith('Chart unavailable');
  expect(controller.pending).toBe(false);
});

it('closes a point while its chart is still preparing after the reads completed', async () => {
  const chart = deferred<void>(), adapter = view();
  const load: PointSeriesLoader['load'] = async (_horizon, _signal, options) => {
    options?.onProgress?.(series, 2, false);
    return series;
  };
  const dispose = vi.fn();
  const controller = new PointSeriesController({ pointSeries: () => ({ load, dispose }) });
  controller.open(retainedPointBuild(), point);
  const pending = controller.load('day', null, { ...adapter, prepare: () => chart.promise });
  controller.close();
  await pending;
  expect(dispose).toHaveBeenCalledOnce();
  chart.resolve();
  await chart.promise;
  expect(adapter.onProgress).not.toHaveBeenCalled();
  expect(adapter.onError).not.toHaveBeenCalled();
});
