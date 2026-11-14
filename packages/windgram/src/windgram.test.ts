import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileResponseSchema, SUPPORT_CUMULUS } from '@av/contracts';
import { formatPointMapLift, type PointFrame } from '@av/client';
import { fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../tests/client-point-fixture.ts';
import { mountWindgram } from './dom.ts';
import { disposePointWindgram, renderPointWindgram } from './point-windgram.ts';
import { buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { sceneData } from './scene-store.ts';
import { renderWindgramKey, renderWindgramSvg } from './svg.ts';
import { formatWindgramReading } from './windgram-readout.ts';

import { barbGeometry, displayedBarbSpeed, quantizedBarbSpeed } from './wind-barb.ts';
import { windBarbGlyph } from './windgram-glyphs.ts';
import { resolveWindgramPresentation } from './windgram-presentation.ts';
import { mpsToKnots } from './windgram-format.ts';
import { hourSampling, sampleHeight } from './windgram-sampling.ts';

it('mirrors the pennant and feathers south of the equator without reversing the staff', () => {
  for (const [direction, x, y] of [[0, 0, -22], [90, 22, 0], [180, 0, 22], [270, -22, 0]]) {
    const north = barbGeometry(65, direction, 22, false), south = barbGeometry(65, direction, 22, true);
    expect(north.staff).toBe(south.staff);
    expect(north.points[1]?.map(value => value || 0)).toEqual([x, y]);
    for (const vertex of [3, 6, 8]) {
      const side = ([px, py]: readonly [number, number]) => Math.sign(x * py - y * px);
      expect(side(north.points[vertex]!)).toBe(1);
      expect(side(south.points[vertex]!)).toBe(-1);
    }
  }
});

it.each(['metric', 'imperial'] as const)('uses the same calm and label thresholds in %s', system => {
  const presentation = resolveWindgramPresentation({ compact: true });
  for (const [speed, expected] of [[0.05, 0], [0.1, 0], [0.49, 1], [0.5, 1], [0.6, system === 'metric' ? 2 : 1]]) {
    const display = displayedBarbSpeed(speed, system);
    const glyph = windBarbGlyph({ x: 0, y: 0, speedKt: mpsToKnots(speed), directionDeg: 0, southernHemisphere: false }, presentation, system);
    expect(display).toBe(expected);
    expect(glyph.calm).toBe(expected === 0);
  }
});

it('keeps a half feather for every positive displayed speed below the first full feather', () => {
  expect(quantizedBarbSpeed(0)).toBe(0);
  expect(barbGeometry(0, 0, 21, false).calm).toBe(true);
  for (const speed of [1, 2, 3, 4, 5, 6, 7]) {
    expect(quantizedBarbSpeed(speed)).toBe(5);
    const geometry = barbGeometry(speed, 0, 21, false);
    expect(geometry.calm).toBe(false);
    expect(geometry.flags).toHaveLength(1);
    expect(geometry.points.some(([x]) => x === 5)).toBe(true);
  }
  for (const speed of [8, 9, 10, 11, 12]) expect(quantizedBarbSpeed(speed)).toBe(10);
});

it('bounds geometry work for extreme finite source winds', () => {
  const geometry = barbGeometry(Math.fround(1e30), 45, 21, false);
  expect(geometry.flags.length).toBeGreaterThanOrEqual(16);
  expect(geometry.flags.length).toBeLessThanOrEqual(21);
  expect(geometry.points.every(point => point.every(Number.isFinite))).toBe(true);
});

it.each(['metric', 'imperial'] as const)('compresses extreme %s pennants inside a mobile staff', system => {
  const presentation = resolveWindgramPresentation({ compact: true });
  for (const speed of [195, 200, 205, 245, 250, 255, 400]) {
    const mps = speed / (system === 'metric' ? 3.6 : 2.2369362921);
    const glyph = windBarbGlyph({ x: 0, y: 0, speedKt: mpsToKnots(mps + 0.00001), directionDeg: 0, southernHemisphere: false }, presentation, system);
    const quantized = Math.round(speed / 5) * 5;
    expect(glyph.flags).toHaveLength(Math.floor(quantized / 50) + Math.floor(quantized % 50 / 10) + Number(quantized % 10 >= 5));
    for (const [, y] of glyph.points) expect(y).toBeGreaterThanOrEqual(-22);
    for (const [, y] of glyph.points) expect(y).toBeLessThanOrEqual(0);
  }
});

it('uses one temperature datum when a native level coincides with the 2 m observation', () => {
  const { forecast, profile, sample } = fixture([1]);
  const [hour] = forecast([sample.frames[0], profile.frames[0]]).hours;
  const frame = {
    ...hour, modelTerrainM: 500,
    surface: { ...hour.surface, temperatureC: 20 },
    levels: [{ ...hour.levels[0], heightM: 502, temperatureC: 19 }, { ...hour.levels[1], heightM: 602, temperatureC: 18 }],
  };
  const known = hourSampling(frame);
  expect(known.temperatureC).toEqual([{ altitudeM: 502, value: 20 }, { altitudeM: 602, value: 18 }]);
  expect(sampleHeight(known.lapseCPer1000Ft, 502)).toBeCloseTo(-6.096);
  const missing = hourSampling({ ...frame, surface: { ...frame.surface, temperatureC: null } });
  expect(sampleHeight(missing.temperatureC, 502)).toBe(19);
});

const point = { lat: 37.65, lon: -79.8 };

function fixture(hours: readonly number[], mapFrameCount = hours.length) {
  const build = fixtureProfileBuild({ frameHours: hours, mapFrameCount });
  const expectedFrames = build.manifest.frames.map(frame => frame.id);
  const url = `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=${expectedFrames.join(',')}&layers=`;
  const sample = fixturePointSample(build, url + 'usable-lift-msl,usable-lift-agl');
  const profile = fixtureProfileResponse(build, url + 'thermal-top-msl,pbl-height-agl,thermal-velocity,sfc-temp-c,wind-gust-10m');
  const forecast = (frames: readonly PointFrame[]) => createPointForecast(build, point)(build.manifest.frames, new Map(frames.map(frame => [frame.id, frame])));
  const view = (frames: readonly PointFrame[], compact = false) => {
    const site = forecast(frames);
    return buildWindgramView(site, { unitSystem: 'metric', compact, timeZone: site.site.timeZone, hours: site.hours });
  };
  return { build, sample, profile, forecast, view };
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, ((event: Event) => void)[]>();
  attributes = new Map<string, string>();
  style: { cssText?: string } = {};
  textContent = '';
  innerHTML = '';
  hidden = false;
  className = '';
  id = '';
  role = '';
  ariaLabel = '';
  ariaPressed = '';
  disabled = false;
  type = '';
  value = '';
  checked = false;
  tabIndex = -1;
  clientWidth = 420;
  constructor(readonly tag: string, readonly ownerDocument?: Document) {}
  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = [];
    this.innerHTML = '';
    this.append(...children);
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

function visit(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap(visit)];
}

afterEach(() => vi.unstubAllGlobals());

describe('Windgram data', () => {
  it.each([false, true])('shows the sampled ceiling below native ground (compact=%s)', compact => {
    const { sample, profile, forecast, view } = fixture([20, 21, 22, 23]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    const [low, calm, missing, outside] = frames;
    low.layers['usable-lift-msl'] = { ...low.layers['usable-lift-msl'], value: 1300, interpolated: true, support: SUPPORT_CUMULUS };
    low.layers['usable-lift-agl'] = { ...low.layers['usable-lift-agl'], value: 350, interpolated: true, support: SUPPORT_CUMULUS };
    calm.layers['usable-lift-msl'] = { ...calm.layers['usable-lift-msl'], value: null, status: 'no-usable-lift' };
    calm.layers['usable-lift-agl'] = { ...calm.layers['usable-lift-agl'], value: 0, status: 'no-usable-lift' };
    calm.layers['thermal-top-msl'] = { ...calm.layers['thermal-top-msl'], value: 1500 };
    calm.layers['pbl-height-agl'] = { ...calm.layers['pbl-height-agl'], value: 100 };
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      missing.layers[layer] = { ...missing.layers[layer], value: null, status: 'unavailable' };
      outside.layers[layer] = { ...outside.layers[layer], value: null, status: 'outside-domain' };
    }
    const result = forecast(frames);
    expect(result.site.timeZone).toBe('Etc/GMT+5');
    const lift = result.hours.map(hour => hour.mapLift);
    expect(formatPointMapLift(lift[0], 'metric')).toBe('MSL 1300 m · AGL 350 m · Surface elevation unknown · Map Cu');
    expect(lift[0].agl).toMatchObject({ value: 350, interpolated: true, surfaceId: 'gfs-fine' });
    expect(lift[1].agl).toMatchObject({ value: 0, status: 'no-usable-lift' });
    expect(formatPointMapLift(lift[1], 'metric')).toContain('AGL no usable lift');
    expect(formatPointMapLift(lift[2], 'metric')).toContain('AGL unavailable');
    expect(formatPointMapLift(lift[3], 'metric')).toContain('AGL outside coverage');
    expect(frames.every(frame => frame.derived.usableLiftTopV2M === 2500)).toBe(true);

    const scene = view(frames, compact);
    expect(scene.floorM).toBeLessThan(1300);
    expect(scene.hours.map(hour => hour.usableLiftTopM)).toEqual([1300, null, null, null]);
    const svg = renderWindgramSvg(scene);
    expect(svg.match(/data-map-lift-ceiling/g)).toHaveLength(1);
    expect(svg).toContain('Map usable lift');
    expect(readWindgram(scene, 0, 1300)).toMatchObject({ heightM: 1300, temperatureF: null, speedKt: null, heightAglM: null });
    expect(readWindgram(scene, 1, 1800)).toMatchObject({ nativeThermalTopM: 1500, modelPblTopM: 1600, heightAglM: 300, heightAglReference: 'model' });
  });

  it('keeps the manifest time axis while a scheduled hour lacks data', () => {
    const { sample, profile, forecast, view } = fixture([22, 23, 24, 27]);
    const frames = [sample.frames[0], profile.frames[2], profile.frames[3]];
    const hours = forecast(frames).hours;
    expect(hours.map(hour => hour.levels.length)).toEqual([0, 0, 4, 4]);
    expect(hours[0].modelTerrainM).toBeNull();
    expect(hours[0].mapLift.terrainM).toBe(1500);
    const scene = view(frames);
    expect(scene.hours).toHaveLength(4);
    expect(scene.hours[3].x - scene.hours[2].x).toBeCloseTo(3 * (scene.hours[2].x - scene.hours[1].x));
    expect(readWindgram(scene, 0, 1900)).toMatchObject({ heightAglM: 400, heightAglReference: 'terrain', speedKt: null });
    expect(readWindgram(scene, 1, 1900)).toMatchObject({ heightAglM: null, heightAglReference: null, temperatureF: null });
    expect(readWindgram(scene, 2, 1800).speedKt).toBeCloseTo(9.7192);
  });

  it('fits the plot and axes within the panel height budget', () => {
    const { profile, forecast } = fixture([20, 21, 22]);
    const site = forecast(profile.frames);
    const scene = buildWindgramView(site, {
      unitSystem: 'metric', compact: true, timeZone: site.site.timeZone, hours: site.hours, widthPx: 420, heightPx: 286
    });
    expect(scene.height).toBe(286);
    expect(scene.hours.map(hour => hour.validAt)).toEqual(site.hours.map(hour => hour.validAt));
    expect(renderWindgramSvg(scene)).toContain('width="420" height="286" viewBox="0 0 420 286"');
  });

  it('preserves the gap where a native level has no height', () => {
    const { profile, view } = fixture([20, 21]);
    profile.frames[0].profile.levels[1].heightM = null;
    profile.frames[1].profile.levels[0].heightM = null;
    const scene = view(profileResponseSchema.parse(profile).frames);
    expect(readWindgram(scene, 0, 1800).temperatureF).toBeCloseTo(53.6);
    expect(readWindgram(scene, 0, 2400)).toMatchObject({
      temperatureF: null, speedKt: null, relativeHumidityPercent: null, verticalVelocityPaS: null, windShear: null
    });
    expect(readWindgram(scene, 0, 3000).temperatureF).toBeCloseTo(39.2);
    expect(readWindgram(scene, 1, 1502).temperatureF).not.toBeNull();
    expect(readWindgram(scene, 1, 1850)).toMatchObject({ temperatureF: null, speedKt: null });
  });

  it('reports the same interpolated humidity that controls hatching', () => {
    const { profile, view } = fixture([20]);
    const column = profile.frames[0].profile;
    column.levels = [
      { ...column.levels[0], pressureHpa: 510, heightM: 5000, temperatureC: -25, dewPointC: -32 },
      { ...column.levels[1], pressureHpa: 420, heightM: 6500, temperatureC: -40, dewPointC: -40 },
    ];
    const reading = readWindgram(view(profile.frames), 0, 6312.5);
    expect(reading).toMatchObject({ cloud: 'humidity', temperatureF: -36.625, dewPointC: -39 });
    expect(reading.relativeHumidityPercent).toBeCloseTo(94.014, 3);
  });

  it('keeps Day 1 hourly column width unchanged when 3-hourly later days are present', () => {
    const dayOneHours = [14, 15, 16, 17, 18];
    const mixedHours = [...dayOneHours, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54];
    const singleDay = fixture(dayOneHours);
    const multiDay = fixture(mixedHours);
    const singleSite = singleDay.forecast(singleDay.profile.frames);
    const multiSite = multiDay.forecast(multiDay.profile.frames);
    const dayKey = singleSite.hours[0].validAt.slice(0, 10);
    const singleView = buildWindgramView(singleSite, {
      unitSystem: 'metric',
      timeZone: singleSite.site.timeZone,
      hours: { timeZone: singleSite.site.timeZone, dateKey: dayKey }
    });
    const multiView = buildWindgramView(multiSite, {
      unitSystem: 'metric',
      timeZone: multiSite.site.timeZone,
      hours: { timeZone: multiSite.site.timeZone, dateKey: dayKey }
    });
    expect(multiView.columnWidth).toBeCloseTo(singleView.columnWidth, 5);
  });

  it('reads gust and precipitation classes from the published descriptors', () => {
    const { build, profile, forecast } = fixture([15]);
    expect(forecast(profile.frames).semantics).toEqual({ capeLabel: 'CAPE', gust: 'instant', precipitation: 'windowMeanRate' });
    if (build.manifest.version !== 5) throw new Error('Expected v5');
    build.manifest.descriptors.layers['wind-gust-10m']!.timeSupport = 'interval-maximum';
    expect(forecast(profile.frames).semantics.gust).toBe('hourMax');
    expect(renderWindgramKey('imperial')).toContain('Map usable lift');
  });

  it('formats horizontal wind thresholds in displayed units', () => {
    const metric = renderWindgramKey('metric'), imperial = renderWindgramKey('imperial');
    expect(metric).toContain('Wind · half 5 / full 10 / flag 50 km/h');
    expect(metric).toContain('Green wind is below 16.7 km/h');
    expect(imperial).toContain('Wind · half 5 / full 10 / flag 50 mph');
    expect(imperial).toContain('Green wind is below 10.4 mph');
  });

  it('uses pinned CAPE and gust semantics for an older build of the same model', () => {
    const { build, profile } = fixture([15]);
    const pointFrames = new Map(profile.frames.map(frame => [frame.id, frame]));
    const read = () => {
      const site = createPointForecast(build, point)(build.manifest.frames, pointFrames);
      const scene = buildWindgramView(site, { unitSystem: 'metric', timeZone: site.site.timeZone });
      const reading = { ...readWindgram(scene, 0, 1800), capeJkg: 500, gustKt: 10 };
      return formatWindgramReading(sceneData(scene), reading, 'surface').join(' · ');
    };
    expect(read()).toContain('CAPE 500 J/kg');
    expect(read()).toContain('gust sample');
    build.manifest.descriptors.layers['cape-jkg'].label = 'Retained CAPE';
    build.manifest.descriptors.layers['wind-gust-10m'].timeSupport = 'interval-maximum';
    expect(read()).toContain('Retained CAPE 500 J/kg');
    expect(read()).toContain('hour-max gust');
  });

  it('converts only changed hours as sample and profile pages arrive', () => {
    const { build, sample, profile } = fixture(Array.from({ length: 120 }, (_, i) => i + 1), 24);
    const convert = createPointForecast(build, point);
    const frames = build.manifest.frames, first = sample.frames[0];
    const loaded = new Map<string, PointFrame>([[first.id, first]]);
    const before = convert(frames, loaded).hours;
    loaded.set(first.id, { ...profile.frames[0], layers: { ...profile.frames[0].layers, ...first.layers } });
    loaded.set(sample.frames[48].id, sample.frames[48]);
    const after = convert(frames, loaded).hours;
    expect(after.flatMap((hour, index) => hour === before[index] ? [] : [index])).toEqual([0, 48]);
    expect(after[0].levels).toBe(profile.frames[0].profile.levels);
    expect(convert(frames.slice(0, 24), loaded).hours[0]).toBe(after[0]);
    expect(convert(frames, loaded).hours[48]).toBe(after[48]);
  });

  it('reuses the mounted day chart across later-day progress pages and updates on resize or mode change', () => {
    const head = new FakeElement('head');
    const otherHead = new FakeElement('head');
    vi.stubGlobal('document', { head: otherHead, createElement: (tag: string) => new FakeElement(tag) });
    let resizeCallback: (() => void) | null = null;
    const disconnected = vi.fn();
    let maxHeight = '50%';
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: Object.assign(new EventTarget(), {
        getComputedStyle: () => ({ maxHeight }),
        ResizeObserver: class {
          constructor(callback: () => void) { resizeCallback = callback; }
          observe(): void {}
          disconnect(): void { disconnected(); }
        }
      })
    };
    const { build, sample, profile } = fixture([14, 15, 29, 38, 39]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    const root = owner.createElement('div');
    const container = root as unknown as HTMLElement;
    const onFrame = vi.fn();

    renderPointWindgram(container, { frames: frames.slice(0, 2) }, build, {
      point, frameId: 'f014', unitSystem: 'metric', totalFrames: 5, loading: true, onFrame
    });
    const host = visit(root).find(el => el.className === 'av-windgram-host')!;
    expect(host.ownerDocument).toBe(owner);
    expect(head.children).toHaveLength(2);
    expect(otherHead.children).toHaveLength(0);
    // A percentage can remain unresolved in computed style. The chart keeps its natural height.
    expect(Number(/viewBox="0 0 420 (\d+)"/.exec(host.innerHTML)?.[1])).toBeGreaterThan(286);
    maxHeight = '286px';
    resizeCallback!();
    expect(host.innerHTML).toContain('viewBox="0 0 420 286"');
    const htmlSpy = vi.fn();
    let currentHtml = host.innerHTML;
    Object.defineProperty(host, 'innerHTML', {
      get: () => currentHtml,
      set: (next: string) => { htmlSpy(); currentHtml = next; }
    });

    // Appending later-day frames keeps Day 1's mounted SVG untouched.
    renderPointWindgram(container, { frames }, build, {
      point, frameId: 'f014', unitSystem: 'metric', totalFrames: 5, loading: false, onFrame
    });
    expect(htmlSpy).not.toHaveBeenCalled();

    // Toggling height inspection updates mode in-place without replacing SVG innerHTML.
    const checkbox = visit(root).find(el => el.tag === 'input' && el.type === 'checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(htmlSpy).not.toHaveBeenCalled();
    expect(host.getAttribute('aria-label')).toContain('inspect height');

    // Resizing the host recomputes the chart width.
    host.clientWidth = 640;
    resizeCallback!();
    expect(htmlSpy).toHaveBeenCalledOnce();
    expect(host.innerHTML).toContain('viewBox="0 0 640');

    const laterDay = visit(root).filter(el => el.className === 'av-windgram-day').at(-1)!;
    laterDay.dispatchEvent(new Event('click'));
    expect(onFrame).toHaveBeenCalledExactlyOnceWith('f038');
    renderPointWindgram(container, { frames: frames.slice(0, 2) }, build, {
      point, frameId: 'f014', unitSystem: 'metric', totalFrames: 2, loading: false, onFrame
    });
    laterDay.dispatchEvent(new Event('click'));
    expect(onFrame).toHaveBeenCalledTimes(1);

    disposePointWindgram(container);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('restores the selected map lift card after hover and blur, and clears it on Escape', () => {
    const { sample, view } = fixture([20, 21]);
    sample.frames[1].layers['usable-lift-msl']!.value = 2200;
    sample.frames[1].layers['usable-lift-agl']!.value = 700;
    const scene = view(sample.frames);
    const cursor = new FakeElement('g');
    const agl = new FakeElement('text');
    const msl = new FakeElement('text');
    const markers = new Map([['[data-windgram-cursor]', cursor], ['[data-cursor-agl]', agl], ['[data-cursor-msl]', msl]]);
    const svg = {
      querySelector: (selector: string) => markers.get(selector) ?? null,
      getScreenCTM: () => ({ inverse: () => ({}) })
    };
    const host = Object.assign(new FakeElement('div'), {
      ownerDocument: {},
      querySelector: (selector: string) => selector === 'svg.windgram' ? svg : null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: scene.width, bottom: scene.height })
    });
    vi.stubGlobal('DOMPoint', class {
      constructor(readonly x: number, readonly y: number) {}
      matrixTransform() { return this; }
    });
    const chart = mountWindgram(host as unknown as HTMLElement, { view: scene, idPrefix: 'lift-card', selectedValidAt: scene.hours[0].validAt });
    const point = (type: string, y = scene.top + 10) => host.dispatchEvent(Object.assign(new Event(type), {
      pointerType: 'mouse', pointerId: 1, clientX: scene.hours[1].x, clientY: y
    }));
    const expectLift = (aglText: string, mslText: string) => {
      expect(cursor.getAttribute('visibility')).toBe('visible');
      expect([agl.textContent, msl.textContent]).toEqual([aglText, mslText]);
    };

    point('pointermove');
    expectLift('700 m AGL', '2200 m MSL');
    point('pointermove', 0);
    expectLift('500 m AGL', '2000 m MSL');
    point('pointermove');
    point('pointerleave');
    expectLift('500 m AGL', '2000 m MSL');
    point('pointerdown');
    point('pointerup');
    host.dispatchEvent(new Event('blur'));
    expectLift('700 m AGL', '2200 m MSL');
    host.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    point('pointerleave');
    expect(cursor.getAttribute('visibility')).toBe('hidden');
    chart.dispose();
  });
});
