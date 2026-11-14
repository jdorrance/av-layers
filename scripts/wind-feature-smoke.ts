import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

export interface WindFeatureSmokeOptions {
  baseUrl: string;
  channel?: string;
  headed?: boolean;
  timeoutMs?: number;
}

export type WindFeatureCheckStatus = 'pass' | 'fail';

export interface WindFeatureCheck {
  name: string;
  status: WindFeatureCheckStatus;
  detail?: string;
}

export interface WindFeatureSmokeResult {
  ok: boolean;
  baseUrl: string;
  checks: WindFeatureCheck[];
  numericRequests: number;
  pageErrors: string[];
}

class SmokeFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

function numericFrameRoot(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  return /\/v1\/models\/[^/]+\/runs\/[^/]+\/data\/[^/]+$/.test(url.pathname);
}

function numericChunk(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  return /\/v1\/models\/[^/]+\/runs\/[^/]+\/data\/[^/]+\/(?:wind|fine)\/\d+$/.test(url.pathname);
}

function numericRequest(raw: string): boolean {
  return numericFrameRoot(raw) || numericChunk(raw);
}

function viewportHeight(width: number): number {
  return width >= 1000 ? 900 : 844;
}

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }

function intersects(a: Rect, b: Rect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

function rectOf(box: { x: number; y: number; width: number; height: number } | null, name: string): Rect {
  assert(box !== null, `${name} has no layout box`);
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, width: box.width, height: box.height };
}

async function waitForNumeric(page: Page, requests: string[], count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (requests.length < count && Date.now() < deadline) await page.waitForTimeout(100);
  assert(requests.length >= count, `Expected ${count} numeric wind requests, observed ${requests.length}`);
}

async function waitForNumericSchema(page: Page, requests: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((!requests.some(numericFrameRoot) || !requests.some(numericChunk)) && Date.now() < deadline) await page.waitForTimeout(100);
  assert(requests.some(numericFrameRoot), 'No numeric frame root request observed');
  assert(requests.some(numericChunk), 'No numeric wind/fine chunk request observed');
}

async function waitForMatchingRaster(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const status = document.querySelector('#frame-status');
    const quality = status?.getAttribute('data-quality');
    const text = status?.textContent ?? '';
    return (quality === 'overview' || quality === 'detail') && !text.includes('Loading selected time') && !text.includes('Loading this view') && !text.includes('No forecast shown');
  }, undefined, { timeout: timeoutMs });
}

async function readWindCanvas(page: Page): Promise<{
  canvasCount: number;
  allBackingLarge: boolean;
  backing: { width: number; height: number };
  container: { width: number; height: number };
  regionAlphaPixels: number;
}> {
  return page.evaluate(() => {
    const windCanvases: HTMLCanvasElement[] = [];
    for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>('#map canvas'))) {
      if (canvas.classList.contains('maplibregl-canvas')) continue;
      if (canvas.getContext('2d')) windCanvases.push(canvas);
    }
    let visible: HTMLCanvasElement | null = null;
    let allBackingLarge = windCanvases.length > 0;
    for (const canvas of windCanvases) {
      if (canvas.width <= 100 || canvas.height <= 100) allBackingLarge = false;
      if (!visible && getComputedStyle(canvas).display !== 'none') visible = canvas;
    }
    const map = document.querySelector('#map');
    const containerRect = map ? map.getBoundingClientRect() : null;
    if (!visible) return {
      canvasCount: windCanvases.length,
      allBackingLarge,
      backing: { width: 0, height: 0 },
      container: { width: containerRect?.width ?? 0, height: containerRect?.height ?? 0 },
      regionAlphaPixels: 0
    };
    const context = visible.getContext('2d');
    const rect = visible.getBoundingClientRect();
    const scaleX = rect.width > 0 ? visible.width / rect.width : 1;
    const scaleY = rect.height > 0 ? visible.height / rect.height : 1;
    const regionCss = 240;
    const x = Math.max(0, Math.floor(visible.width / 2 - regionCss * scaleX / 2));
    const y = Math.max(0, Math.floor(visible.height / 2 - regionCss * scaleY / 2));
    const width = Math.max(1, Math.min(visible.width - x, Math.floor(regionCss * scaleX)));
    const height = Math.max(1, Math.min(visible.height - y, Math.floor(regionCss * scaleY)));
    const pixels = context?.getImageData(x, y, width, height).data ?? new Uint8ClampedArray();
    let regionAlphaPixels = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! > 0) regionAlphaPixels++;
    return {
      canvasCount: windCanvases.length,
      allBackingLarge,
      backing: { width: visible.width, height: visible.height },
      container: { width: containerRect?.width ?? 0, height: containerRect?.height ?? 0 },
      regionAlphaPixels
    };
  });
}

async function openMenu(page: Page): Promise<void> {
  const popup = page.locator('.wind-controls-popup');
  if (!(await popup.isVisible())) await page.locator('.wind-controls-trigger').click();
  await popup.waitFor({ state: 'visible' });
}

async function chooseStyle(page: Page, label: string): Promise<void> {
  await openMenu(page);
  await page.getByRole('radio', { name: label, exact: true }).click();
  await page.locator('.wind-controls-popup').waitFor({ state: 'hidden' });
}

async function launchBrowser(options: WindFeatureSmokeOptions): Promise<Browser> {
  if (options.channel) return chromium.launch({ headless: !options.headed, channel: options.channel });
  try { return await chromium.launch({ headless: !options.headed }); }
  catch (error) {
    try { return await chromium.launch({ headless: !options.headed, channel: 'chrome' }); }
    catch { throw error; }
  }
}

export async function runWindFeatureSmoke(options: WindFeatureSmokeOptions): Promise<WindFeatureSmokeResult> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const checks: WindFeatureCheck[] = [];
  const numericRequests: string[] = [];
  const pageErrors: string[] = [];
  const browser = await launchBrowser(options);
  const results = (): WindFeatureSmokeResult => ({
    ok: checks.every(check => check.status !== 'fail'),
    baseUrl: pageUrl,
    checks,
    numericRequests: numericRequests.length,
    pageErrors
  });
  const run = async (name: string, action: () => Promise<void>, fatal = true): Promise<void> => {
    try {
      await action();
      checks.push({ name, status: 'pass' });
      console.log(`PASS ${name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      checks.push({ name, status: 'fail', detail });
      console.error(`FAIL ${name}: ${detail}`);
      if (fatal) throw error;
    }
  };
  const pageUrl = (() => {
    const url = new URL(options.baseUrl);
    if (!url.searchParams.has('lat') || !url.searchParams.has('lon') || !url.searchParams.has('z')) {
      url.searchParams.set('lat', '40');
      url.searchParams.set('lon', '-100');
      url.searchParams.set('z', '3');
    }
    return url.href;
  })();
  const context = await browser.newContext({ viewport: { width: 1200, height: viewportHeight(1200) } });
  const page = await context.newPage();
  page.on('request', request => { if (numericRequest(request.url())) numericRequests.push(request.url()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.locator('.wind-controls-trigger').waitFor({ state: 'visible', timeout: timeoutMs });

    await run('wind controls and rail are visible', async () => {
      const trigger = page.locator('.wind-controls-trigger');
      const rail = page.locator('.wind-controls-rail');
      assert(await trigger.isVisible(), 'Wind trigger is not visible');
      assert(await rail.isVisible(), 'Wind height rail is not visible');
      const label = await trigger.getAttribute('aria-label');
      assert(label?.startsWith('Wind controls,') === true, `Unexpected trigger label: ${label}`);
      assert((await rail.locator('.wind-controls-surface').textContent())?.trim() === 'Surface', 'Surface stop is missing');
      assert(await rail.locator('.wind-controls-range').isVisible(), 'Wind height slider is not visible');
    });

    await run('fixture wind field loads through the API', async () => {
      await page.waitForFunction(() => document.querySelectorAll('.ct-hour').length > 0, undefined, { timeout: timeoutMs });
      await waitForNumeric(page, numericRequests, 1, timeoutMs);
      await waitForNumericSchema(page, numericRequests, timeoutMs);
      await page.waitForFunction(() => {
        const root = document.querySelector('.wind-controls');
        return root?.getAttribute('data-status') === 'ready';
      }, undefined, { timeout: timeoutMs });
      await waitForMatchingRaster(page, timeoutMs);
    });

    await run('barbs render nonzero alpha on sized canvases', async () => {
      const root = page.locator('.wind-controls');
      await chooseStyle(page, 'XC barbs');
      assert(await root.getAttribute('data-style') === 'barbs', 'Barbs style did not select');
      await page.waitForFunction(() => document.querySelector('.wind-controls')?.getAttribute('data-status') === 'ready', undefined, { timeout: timeoutMs });
      await waitForMatchingRaster(page, timeoutMs);
      await page.waitForTimeout(150);
      const canvas = await readWindCanvas(page);
      assert(canvas.canvasCount > 0, 'No 2D wind canvases were found');
      assert(canvas.container.width > 100 && canvas.container.height > 100, `Map container is ${canvas.container.width}x${canvas.container.height}`);
      assert(canvas.allBackingLarge, `Wind canvas backing is ${canvas.backing.width}x${canvas.backing.height}`);
      assert(canvas.backing.width > 100 && canvas.backing.height > 100, `Visible wind canvas backing is ${canvas.backing.width}x${canvas.backing.height}`);
      assert(canvas.regionAlphaPixels > 0, 'No barbs alpha pixels rendered around the admitted fixture location');
    });

    await run('style switching reuses the resident field', async () => {
      const root = page.locator('.wind-controls');
      const before = numericRequests.length;
      await chooseStyle(page, 'XC barbs');
      assert(await root.getAttribute('data-style') === 'barbs', 'Barbs style did not select');
      assert(await page.locator('.wind-controls-style[aria-label="XC barbs"]').getAttribute('aria-checked') === 'true', 'Barbs radio is not checked');
      await chooseStyle(page, 'Flow and sparse barbs');
      assert(await root.getAttribute('data-style') === 'hybrid', 'Hybrid style did not select');
      await chooseStyle(page, 'White trails');
      assert(await root.getAttribute('data-style') === 'trails', 'Trails style did not select');
      await page.waitForTimeout(400);
      assert(numericRequests.length === before, `Style changes made ${numericRequests.length - before} numeric requests`);
    });

    await run('surface, AGL and lift heights reuse the resident field', async () => {
      const root = page.locator('.wind-controls');
      const scale = page.locator('.wind-controls-scale');
      const range = page.getByRole('slider', { name: 'Wind height' });
      const before = numericRequests.length;
      await page.getByRole('button', { name: 'Surface', exact: true }).click();
      assert(await scale.getAttribute('data-height') === 'surface', 'Surface height did not select');
      await range.evaluate(element => {
        const input = element as HTMLInputElement;
        input.value = '3000';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      assert(await scale.getAttribute('data-height') === 'fixed', 'AGL height did not select');
      assert(await range.inputValue() === '3000', 'AGL range did not retain 3000 m');
      assert((await range.getAttribute('aria-valuetext'))?.includes('AGL') === true, 'AGL value text is missing');
      await page.getByRole('button', { name: /^Top of lift/ }).click();
      assert(await scale.getAttribute('data-height') === 'lift', 'Top of lift height did not select');
      assert(await range.inputValue() === '3000', 'Top of lift did not retain the fixed height');
      await page.getByRole('button', { name: 'Surface', exact: true }).click();
      assert(await root.getAttribute('data-visible') === 'true', 'Wind visibility changed with height selection');
      await page.waitForTimeout(400);
      assert(numericRequests.length === before, `Height changes made ${numericRequests.length - before} numeric requests`);
    });

    await run('menu focus stays put without scrolling', async () => {
      const trigger = page.locator('.wind-controls-trigger');
      const rail = page.locator('.wind-controls-rail');
      const beforeTrigger = await trigger.boundingBox();
      const beforeRail = await rail.boundingBox();
      const beforeScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      await trigger.focus();
      await page.keyboard.press('Enter');
      const popup = page.locator('.wind-controls-popup');
      await popup.waitFor({ state: 'visible' });
      const selected = await page.locator('.wind-controls-style[aria-checked="true"]').getAttribute('aria-label');
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      assert(focused === selected, `Focused style ${focused} does not match selected ${selected}`);
      const afterTrigger = await trigger.boundingBox();
      const afterRail = await rail.boundingBox();
      const afterScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert(JSON.stringify(beforeTrigger) === JSON.stringify(afterTrigger), 'Opening the menu moved the trigger');
      assert(JSON.stringify(beforeRail) === JSON.stringify(afterRail), 'Opening the menu moved the rail');
      assert(afterScroll.x === beforeScroll.x && afterScroll.y === beforeScroll.y, 'Opening the menu scrolled the page');
      const triggerRect = rectOf(afterTrigger, 'Wind trigger');
      const railRect = rectOf(afterRail, 'Wind rail');
      const popupRect = rectOf(await popup.boundingBox(), 'Wind menu');
      assert(Math.abs(popupRect.width - 100) <= 1, `Wind menu width is ${popupRect.width}`);
      assert(Math.abs(popupRect.height - 62) <= 1, `Wind menu height is ${popupRect.height}`);
      assert(Math.abs(popupRect.right - (triggerRect.left - 6)) <= 1, `Wind menu right edge is ${popupRect.right}, trigger left is ${triggerRect.left}`);
      assert(Math.abs(popupRect.bottom - triggerRect.bottom) <= 1, `Wind menu bottom is ${popupRect.bottom}, trigger bottom is ${triggerRect.bottom}`);
      assert(!intersects(popupRect, triggerRect), 'Wind menu overlaps its trigger');
      assert(!intersects(popupRect, railRect), 'Wind menu overlaps the height rail');
      assert(popupRect.left >= 0 && popupRect.right <= await page.evaluate(() => window.innerWidth), 'Wind menu crosses the viewport edge');
      const timelineBox = await page.locator('.compact-timeline').boundingBox();
      if (timelineBox) assert(!intersects(popupRect, rectOf(timelineBox, 'Timeline')), 'Wind menu overlaps the timeline');
      const keyBox = await page.evaluate(() => {
        const element = document.querySelector('#legend') ?? document.querySelector('#lift-key') ?? document.querySelector('[data-lift-key]');
        if (!element) return null;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      });
      if (keyBox) assert(!intersects(popupRect, rectOf(keyBox, 'Lift key')), 'Wind menu overlaps the lift key');
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      const returned = await page.evaluate(() => document.activeElement?.classList.contains('wind-controls-trigger'));
      assert(returned === true, 'Escape did not restore focus to the wind trigger');
    });

    await run('outside pointer closes the menu without stealing focus', async () => {
      await openMenu(page);
      const map = await page.locator('#map').boundingBox();
      assert(map !== null, 'Map element is missing');
      await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
      await page.locator('.wind-controls-popup').waitFor({ state: 'hidden' });
      const focused = await page.evaluate(() => ({ trigger: document.activeElement?.classList.contains('wind-controls-trigger'), tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }));
      await page.locator('#point-card').waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
      if (await page.locator('#point-card').isVisible()) await page.locator('#point-close').click();
      assert(focused.trigger === false, `Outside click stole focus back to the wind trigger from ${focused.tag}`);
    }, false);

    await run('unit switch updates map wind labels', async () => {
      const unit = page.locator('.wind-controls-unit');
      const range = page.getByRole('slider', { name: 'Wind height' });
      const before = numericRequests.length;
      await page.locator('#units-metric').click();
      assert((await unit.textContent())?.trim() === 'm AGL', 'Metric rail label is not m AGL');
      const metricValue = await range.inputValue();
      await page.locator('#units-imperial').click();
      assert((await unit.textContent())?.trim() === 'ft AGL', 'Imperial rail label is not ft AGL');
      assert(await range.inputValue() === metricValue, 'Unit switch changed the physical height');
      assert(await page.locator('#units-imperial').getAttribute('aria-pressed') === 'true', 'Imperial units are not pressed');
      await page.waitForTimeout(400);
      assert(numericRequests.length === before, `Unit changes made ${numericRequests.length - before} numeric requests`);
    });

    await run('unit switch updates point wind labels', async () => {
      await page.locator('#units-metric').click();
      const map = await page.locator('#map').boundingBox();
      assert(map !== null, 'Map element is missing');
      await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
      await page.locator('#point-card').waitFor({ state: 'visible', timeout: timeoutMs });
      await page.waitForFunction(() => (document.querySelector('#point-wind')?.textContent ?? '').trim().length > 0, undefined, { timeout: timeoutMs });
      const metric = (await page.locator('#point-wind').textContent()) ?? '';
      assert(metric.includes('km/h'), `Point wind is not metric: ${metric}`);
      await page.locator('#units-imperial').click();
      await page.waitForFunction(() => (document.querySelector('#point-wind')?.textContent ?? '').includes('mph'), undefined, { timeout: timeoutMs });
      const imperial = (await page.locator('#point-wind').textContent()) ?? '';
      assert(imperial.includes('mph'), `Point wind is not imperial: ${imperial}`);
    }, false);
    if (await page.locator('#point-card').isVisible()) await page.locator('#point-close').click();

    await run('time change clears the resident wind canvases', async () => {
      const canvases = await page.evaluate(() => {
        const state = { clear: 0, stroke: 0, fill: 0 };
        Object.assign(window, { __windSmoke: state });
        let count = 0;
        for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>('#map canvas'))) {
          const context = canvas.getContext('2d');
          if (!context) continue;
          count++;
          const clear = context.clearRect.bind(context), stroke = context.stroke.bind(context), fillText = context.fillText.bind(context);
          context.clearRect = (x, y, width, height) => { state.clear++; clear(x, y, width, height); };
          context.stroke = () => { state.stroke++; stroke(); };
          context.fillText = (text, x, y, maxWidth) => { state.fill++; fillText(text, x, y, maxWidth); };
        }
        return count;
      });
      assert(canvases > 0, 'No 2D wind canvases were found');
      const selected = await page.locator('.ct-hour[aria-checked="true"]').getAttribute('aria-label');
      const beforeClear = await page.evaluate(() => (window as Window & { __windSmoke?: { clear: number } }).__windSmoke?.clear ?? 0);
      const beforeNumeric = numericRequests.length;
      await page.locator('.ct-hour[aria-checked="false"]').first().click();
      await page.waitForFunction(label => document.querySelector('.ct-hour[aria-checked="true"]')?.getAttribute('aria-label') !== label, selected, { timeout: timeoutMs });
      await page.waitForFunction(previous => ((window as Window & { __windSmoke?: { clear: number } }).__windSmoke?.clear ?? 0) > previous, beforeClear, { timeout: timeoutMs });
      const afterClear = await page.evaluate(() => (window as Window & { __windSmoke?: { clear: number } }).__windSmoke?.clear ?? 0);
      assert(afterClear > beforeClear, 'Wind canvases were not cleared on time change');
      assert(numericRequests.length > beforeNumeric, 'Time change did not request a new numeric field');
    });

    await run('320, 390 and 1200 px keep rail, key and timeline clear', async () => {
      for (const width of [320, 390, 1200]) {
        await page.setViewportSize({ width, height: viewportHeight(width) });
        await page.waitForTimeout(300);
        const layout = await page.evaluate(() => {
          const railElement = document.querySelector('.wind-controls-rail');
          const railStyle = railElement ? getComputedStyle(railElement) : null;
          const railRect = railElement && railStyle && railStyle.display !== 'none' && railStyle.visibility !== 'hidden' ? railElement.getBoundingClientRect() : null;
          const rail = railRect && railRect.width > 0 ? { left: railRect.left, right: railRect.right, top: railRect.top, bottom: railRect.bottom, width: railRect.width, height: railRect.height } : null;
          const triggerElement = document.querySelector('.wind-controls-trigger');
          const triggerStyle = triggerElement ? getComputedStyle(triggerElement) : null;
          const triggerRect = triggerElement && triggerStyle && triggerStyle.display !== 'none' && triggerStyle.visibility !== 'hidden' ? triggerElement.getBoundingClientRect() : null;
          const trigger = triggerRect && triggerRect.width > 0 ? { left: triggerRect.left, right: triggerRect.right, top: triggerRect.top, bottom: triggerRect.bottom, width: triggerRect.width, height: triggerRect.height } : null;
          const timelineElement = document.querySelector('.compact-timeline') ?? document.querySelector('#timebar');
          const timelineStyle = timelineElement ? getComputedStyle(timelineElement) : null;
          const timelineRect = timelineElement && timelineStyle && timelineStyle.display !== 'none' && timelineStyle.visibility !== 'hidden' ? timelineElement.getBoundingClientRect() : null;
          const timeline = timelineRect && timelineRect.width > 0 ? { left: timelineRect.left, right: timelineRect.right, top: timelineRect.top, bottom: timelineRect.bottom, width: timelineRect.width, height: timelineRect.height } : null;
          const keyElement = document.querySelector('#legend') ?? document.querySelector('#lift-key') ?? document.querySelector('[data-lift-key]');
          const keyStyle = keyElement ? getComputedStyle(keyElement) : null;
          const keyRect = keyElement && keyStyle && keyStyle.display !== 'none' && keyStyle.visibility !== 'hidden' ? keyElement.getBoundingClientRect() : null;
          const key = keyRect && keyRect.width > 0 ? { left: keyRect.left, right: keyRect.right, top: keyRect.top, bottom: keyRect.bottom, width: keyRect.width, height: keyRect.height } : null;
          const attributionElement = document.querySelector('.maplibregl-ctrl-attrib');
          const attributionStyle = attributionElement ? getComputedStyle(attributionElement) : null;
          const attributionRect = attributionElement && attributionStyle && attributionStyle.display !== 'none' && attributionStyle.visibility !== 'hidden' ? attributionElement.getBoundingClientRect() : null;
          const attribution = attributionRect && attributionRect.width > 0 ? { left: attributionRect.left, right: attributionRect.right, top: attributionRect.top, bottom: attributionRect.bottom, width: attributionRect.width, height: attributionRect.height } : null;
          const unit = document.querySelector('.wind-controls-unit');
          const windBackings: Array<{ width: number; height: number }> = [];
          for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>('#map canvas'))) {
            if (canvas.classList.contains('maplibregl-canvas')) continue;
            if (canvas.getContext('2d')) windBackings.push({ width: canvas.width, height: canvas.height });
          }
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            appTop: document.querySelector('#app')?.getBoundingClientRect().top,
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            rail,
            trigger,
            timeline,
            key,
            attribution,
            unit: unit ? { scrollWidth: unit.scrollWidth, clientWidth: unit.clientWidth } : null,
            windBackings
          };
        });
        assert(layout.documentWidth <= layout.innerWidth + 1, `${width}px page has horizontal overflow`);
        assert(layout.bodyWidth <= layout.innerWidth + 1, `${width}px body has horizontal overflow`);
        assert(layout.appTop === 0, `${width}px app starts at ${layout.appTop}px`);
        assert(layout.rail !== null && layout.trigger !== null, `${width}px wind rail or trigger is missing`);
        assert(layout.timeline !== null, `${width}px timeline is missing`);
        assert(layout.windBackings.length > 0, `${width}px has no wind canvases`);
        assert(layout.windBackings.every(backing => backing.width > 100 && backing.height > 100), `${width}px wind canvas backing is ${layout.windBackings.map(backing => `${backing.width}x${backing.height}`).join(', ')}`);
        assert(layout.rail.width >= 47 && layout.rail.width <= 49, `${width}px rail width is ${layout.rail.width}`);
        const expectedHeight = width >= 1000 ? 238 : 198;
        assert(Math.abs(layout.rail.height - expectedHeight) <= 1, `${width}px rail height is ${layout.rail.height}, expected ${expectedHeight}`);
        for (const [name, rect] of [['rail', layout.rail], ['timeline', layout.timeline], ['key', layout.key]] as const) {
          if (!rect) continue;
          assert(rect.left >= -0.5 && rect.right <= layout.innerWidth + 0.5, `${width}px ${name} crosses the viewport edge`);
          assert(rect.top >= -0.5 && rect.bottom <= layout.innerHeight + 0.5, `${width}px ${name} crosses the vertical viewport edge`);
        }
        assert(!intersects(layout.rail, layout.timeline), `${width}px rail overlaps the timeline`);
        if (layout.key) assert(!intersects(layout.key, layout.timeline), `${width}px key overlaps the timeline`);
        if (layout.key && layout.attribution) assert(!intersects(layout.key, layout.attribution), `${width}px key overlaps attribution`);
        assert(layout.unit !== null && layout.unit.scrollWidth <= layout.unit.clientWidth + 1, `${width}px rail unit label is clipped`);
        assert(layout.timeline.width <= 541, `${width}px timeline width is ${layout.timeline.width}`);
      }
      await page.setViewportSize({ width: 1200, height: viewportHeight(1200) });
    });

    if (pageErrors.length) {
      checks.push({ name: 'page has no runtime errors', status: 'fail', detail: pageErrors[0] });
      console.error(`FAIL page has no runtime errors: ${pageErrors[0]}`);
    } else {
      checks.push({ name: 'page has no runtime errors', status: 'pass' });
      console.log('PASS page has no runtime errors');
    }
  } catch (error) {
    if (checks.length === 0 || checks.at(-1)?.status !== 'fail') {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      checks.push({ name: 'wind feature smoke completed', status: 'fail', detail });
      console.error(`FAIL wind feature smoke completed: ${detail}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return results();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:5173' },
      channel: { type: 'string' },
      headed: { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (values.help) {
    console.log('Usage: node --import tsx scripts/wind-feature-smoke.ts --url http://127.0.0.1:5173 [--channel chrome] [--headed] [--timeout 45000]');
    return;
  }
  const raw = values.url ?? 'http://127.0.0.1:5173';
  const baseUrl = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  const timeout = values.timeout === undefined ? 45_000 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 5_000) throw new Error('--timeout must be an integer of at least 5000 ms');
  const result = await runWindFeatureSmoke({ baseUrl, channel: values.channel, headed: values.headed, timeoutMs: timeout });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`wind-feature-smoke: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
