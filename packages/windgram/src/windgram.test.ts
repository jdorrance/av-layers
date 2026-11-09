import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileResponseSchema, SUPPORT_CUMULUS } from '@av/contracts';
import { formatPointMapLift, type PointFrame } from '@av/contracts/client';
import { fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../tests/client-point-fixture.ts';
import { mountWindgram } from './dom.ts';
import { pointSeriesToSiteForecast, timeZoneForLongitude } from './from-av-profile.ts';
import { disposePointWindgram, renderPointWindgram } from './point-windgram.ts';
import { buildWindgramView, readWindgram } from './scene.ts';
import { renderWindgramKey, renderWindgramSvg } from './svg.ts';

const point = { lat: 37.65, lon: -79.8 };

function fixture(hours: readonly number[]) {
  const build = fixtureProfileBuild({ frameHours: hours, mapFrameCount: hours.length });
  const expectedFrames = build.manifest.frames.map(frame => frame.id);
  const url = `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=${expectedFrames.join(',')}&layers=`;
  const sample = fixturePointSample(build, url + 'usable-lift-msl,usable-lift-agl');
  const profile = fixtureProfileResponse(build, url + 'thermal-top-msl,pbl-height-agl,thermal-velocity,sfc-temp-c,wind-gust-10m');
  const forecast = (frames: readonly PointFrame[]) => pointSeriesToSiteForecast({ frames }, build, { point, expectedFrames });
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
  constructor(readonly tag: string) {}
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
    expect(result.site.timeZone).toBe(timeZoneForLongitude(point.lon));
    const lift = result.hours.map(hour => hour.mapLift);
    expect(formatPointMapLift(lift[0], 'metric')).toBe('MSL 1300 m · AGL 350 m · Terrain unknown · Map Cu');
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
    expect(forecast(profile.frames).semantics).toEqual({ gust: 'instant', precipitation: 'windowMeanRate' });
    if (build.manifest.version !== 5) throw new Error('Expected v5');
    build.manifest.descriptors.layers['wind-gust-10m']!.timeSupport = 'interval-maximum';
    expect(forecast(profile.frames).semantics.gust).toBe('hourMax');
    expect(renderWindgramKey('imperial')).toContain('Map usable lift');
  });

  it('reuses the mounted day chart across later-day progress pages and updates on resize or mode change', () => {
    const head = new FakeElement('head');
    vi.stubGlobal('document', {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag)
    });
    let resizeCallback: (() => void) | null = null;
    const disconnected = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeCallback = callback; }
      observe(): void {}
      disconnect(): void { disconnected(); }
    });
    const { build, sample, profile } = fixture([14, 15, 38, 39]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    const container = new FakeElement('div') as unknown as HTMLElement;
    const onFrame = vi.fn();

    renderPointWindgram(container, { frames: frames.slice(0, 2) }, build, {
      point, frameId: 'f014', unitSystem: 'metric', totalFrames: 4, loading: true, onFrame
    });
    const root = container as unknown as FakeElement;
    const host = visit(root).find(el => el.className === 'av-windgram-host')!;
    expect(host.innerHTML).toContain('viewBox="0 0 420');
    const htmlSpy = vi.fn();
    let currentHtml = host.innerHTML;
    Object.defineProperty(host, 'innerHTML', {
      get: () => currentHtml,
      set: (next: string) => { htmlSpy(); currentHtml = next; }
    });

    // Appending later-day frames keeps Day 1's mounted SVG untouched.
    renderPointWindgram(container, { frames }, build, {
      point, frameId: 'f014', unitSystem: 'metric', totalFrames: 4, loading: false, onFrame
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
