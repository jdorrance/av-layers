import { pointFrameView, seriesTable, type PinnedBuild, type PointSeries, type UnitSystem } from '@av/contracts/client';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderSampleTable(container: HTMLElement, payload: Pick<PointSeries, 'frames'>, layers: readonly string[], build: PinnedBuild): void {
  const model = seriesTable(payload, layers, build.manifest.descriptors.layers, build.manifest.version === 5 ? [] : build.manifest.patches);
  const table = node('table'), head = node('tr');
  head.append(...model.headings.map(label => node('th', label)));
  table.append(head);
  for (const cells of model.rows) {
    const row = node('tr');
    row.append(...cells.map(text => node('td', text)));
    table.append(row);
  }
  container.replaceChildren(table);
}

/** Mount one bounded series; frame/unit updates reuse its bars and cached values. */
export function renderPointSeries(
  container: HTMLElement, payload: Pick<PointSeries, 'frames'>, build: PinnedBuild,
  options: { frameId: string | null; mapFrameId?: string | null; unitSystem: UnitSystem; totalFrames?: number; loading?: boolean; onFrame(id: string): void }
): (frameId: string | null, units?: UnitSystem, mapFrameId?: string | null, loading?: boolean) => void {
  const previous = container.querySelector?.<HTMLElement>('.av-point-chart');
  const previousScroll = previous?.scrollLeft ?? 0;
  const previousSelected = previous?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
  let followSelection = !previous || previous.clientWidth <= 0 || !previousSelected || previousSelected.value !== options.frameId ||
    (previousSelected.offsetLeft >= previousScroll && previousSelected.offsetLeft + previousSelected.offsetWidth <= previousScroll + previous.clientWidth);
  const focused = previous?.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : null;
  const wasOpen = container.querySelector?.<HTMLDetailsElement>('details')?.open ?? false;
  const section = node('section'), summary = node('p'), time = node('p'), incomplete = node('p', 'Forecast incomplete. Some hours could not be loaded.'), chart = node('div'), legend = node('p'), details = node('details'), table = node('div');
  section.className = 'av-point-series'; summary.className = 'av-point-values'; chart.className = 'av-point-chart';
  chart.role = 'group'; chart.ariaLabel = 'Point forecast times in UTC; heights MSL';
  summary.style.cssText = 'font-size:12px;line-height:1.6;margin:4px 0 12px';
  time.className = 'av-point-time'; time.style.cssText = 'font-size:11px;line-height:1.5;margin:4px 0';
  incomplete.className = 'av-point-incomplete'; incomplete.role = 'status';
  incomplete.style.cssText = 'font-size:12px;font-weight:600;margin:4px 0';
  chart.style.cssText = 'position:relative;display:flex;gap:3px;overflow-x:auto;align-items:stretch;min-height:132px;padding:3px';
  legend.style.cssText = 'font-size:11px;opacity:.75;margin:8px 0';
  legend.className = 'av-point-legend';
  const heading = node('summary', 'Values and source surfaces');
  heading.style.cssText = 'font-size:11px;cursor:pointer;margin:8px 0'; details.append(heading, table);
  details.addEventListener('toggle', () => {
    if (details.open && !table.children.length) renderSampleTable(table, payload, Object.keys(payload.frames[0]?.layers ?? {}), build);
  });
  const viewsByUnit: Partial<Record<UnitSystem, ReturnType<typeof pointFrameView>[]>> = {};
  const getViews = (units: UnitSystem) => viewsByUnit[units] ??= payload.frames.map(frame => pointFrameView(frame, build, units));
  const views = getViews(options.unitSystem);
  const knownFloors = views.filter(view => view.terrainM !== null).length;
  legend.textContent = knownFloors === 0 ? 'UTC · Heights MSL · Lift ceiling marks blue · LCL gold · Terrain unknown'
    : knownFloors === views.length ? 'UTC · Heights MSL · Lift bars blue · LCL gold · Terrain grey'
    : 'UTC · Heights MSL · Lift bars blue; ceiling marks where terrain is unknown · LCL gold · Terrain grey where known';
  if (views.some(view => view.thermalTopM !== null)) legend.textContent += ' · Native thermal top purple';
  const heightValues = views.flatMap(view => [view.terrainM, view.mslM, view.lclM, view.thermalTopM].filter((value): value is number => value !== null));
  const minimum = Math.min(0, ...heightValues), span = Math.max(1, ...heightValues) - minimum;
  const percent = (meters: number) => Math.min(100, Math.max(0, (meters - minimum) / span * 100));
  const positions = new Map(build.manifest.frames.map((frame, index) => [frame.id, index]));
  const elapsed = payload.frames.map((frame, index) => index && positions.get(frame.id) === positions.get(payload.frames[index - 1].id)! + 1
    ? (Date.parse(frame.validTime) - Date.parse(payload.frames[index - 1].validTime)) / 3600000 : 0);
  const bars = payload.frames.map((frame, index) => {
    const date = frame.validTime.slice(0, 10), firstOfDay = index === 0 || date !== payload.frames[index - 1].validTime.slice(0, 10);
    const width = firstOfDay ? 54 : 20;
    const gapText = elapsed[index] > 1 ? `+${elapsed[index]} h` : '', gapWidth = gapText ? Math.max(24, gapText.length * 6) : 0;
    const button = node('button'), plot = node('span'), hour = node('span', `${firstOfDay ? `${date.slice(5)} ` : ''}${frame.validTime.slice(11, 13)}`);
    button.type = 'button'; button.value = frame.id;
    button.style.cssText = `position:relative;flex:1 0 ${width}px;min-width:${width}px;margin-left:${gapWidth}px;padding:2px;border:1px solid transparent;border-radius:4px;background:transparent;color:inherit;cursor:pointer`;
    plot.style.cssText = 'display:block;position:relative;height:100px;border-bottom:1px solid #89959e';
    hour.style.cssText = 'display:block;font-size:10px;line-height:20px;white-space:nowrap';
    const view = views[index];
    if (view.terrainM !== null) {
      const floor = node('span'); floor.className = 'av-point-terrain'; floor.style.cssText = `position:absolute;display:block;bottom:0;width:100%;height:${percent(view.terrainM)}%;background:#89959e55`;
      plot.append(floor);
    }
    if (view.mslM !== null) {
      const lift = node('span');
      lift.className = view.terrainM === null ? 'av-point-ceiling-marker' : 'av-point-lift-bar';
      lift.style.cssText = view.terrainM === null
        ? `position:absolute;display:block;bottom:${percent(view.mslM)}%;width:100%;height:3px;background:#229ec6`
        : `position:absolute;display:block;bottom:${percent(view.terrainM)}%;width:100%;height:${Math.max(0, percent(view.mslM) - percent(view.terrainM))}%;background:#229ec6`;
      plot.append(lift);
    }
    if (view.lclM !== null) {
      const lcl = node('span'); lcl.style.cssText = `position:absolute;display:block;bottom:${percent(view.lclM)}%;width:100%;height:2px;background:#b8860b`;
      plot.append(lcl);
    }
    if (view.thermalTopM !== null) {
      const top = node('span'); top.className = 'av-point-native-top';
      top.style.cssText = `position:absolute;display:block;bottom:${percent(view.thermalTopM)}%;width:100%;height:2px;background:#ae78d6`;
      plot.append(top);
    }
    button.append(plot, hour); button.addEventListener('click', () => options.onFrame(frame.id));
    if (gapText) {
      const gap = node('span', gapText); gap.className = 'av-point-gap'; gap.ariaHidden = 'true';
      gap.style.cssText = `position:absolute;left:-${gapWidth + 2}px;bottom:2px;width:${gapWidth}px;text-align:center;font-size:9px;line-height:20px;white-space:nowrap;opacity:.75`;
      button.append(gap);
    }
    button.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? payload.frames.length - 1 : -1;
      if (target < 0 || target >= payload.frames.length) return;
      event.preventDefault(); bars[target].focus(); options.onFrame(payload.frames[target].id);
    });
    chart.append(button); return button;
  });
  section.append(chart, time, incomplete, summary, legend, details); container.replaceChildren(section);
  chart.scrollLeft = previousScroll;
  details.open = wasOpen;
  let units = options.unitSystem;
  const partial = options.totalFrames === undefined ? options.loading === true : payload.frames.length < options.totalFrames;
  let loading = options.loading ?? partial;
  let selectedFrameId = options.frameId;
  let mapFrameId = options.mapFrameId === undefined ? options.frameId : options.mapFrameId;
  let labelledUnits: UnitSystem | undefined;
  const update = (frameId: string | null, nextUnits = units, nextMapFrameId = mapFrameId, nextLoading = loading) => {
    units = nextUnits;
    loading = nextLoading;
    followSelection ||= frameId !== selectedFrameId;
    selectedFrameId = frameId;
    incomplete.hidden = !partial || loading;
    mapFrameId = nextMapFrameId;
    const currentViews = getViews(units);
    const selectedIndex = payload.frames.findIndex(frame => frame.id === frameId), frame = payload.frames[selectedIndex];
    const pointFrame = frame ?? build.manifest.frames.find(frame => frame.id === frameId);
    const mapFrame = build.manifest.frames.find(frame => frame.id === mapFrameId);
    const utc = (value: string) => `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
    time.textContent = pointFrame && pointFrame.id !== mapFrameId ? `Point: ${utc(pointFrame.validTime)} · Map: ${mapFrame ? utc(mapFrame.validTime) : 'unavailable'}`
      : pointFrame ? `Point and map: ${utc(pointFrame.validTime)}` : 'Point time unavailable';
    const hasSelection = frame !== undefined;
    summary.textContent = frame ? currentViews[selectedIndex].summary : loading ? 'Loading selected point hour…' : 'Selected point hour unavailable.';
    bars.forEach((bar, index) => {
      const frame = payload.frames[index], selected = frame.id === frameId;
      bar.ariaPressed = String(selected); bar.tabIndex = selected || (!hasSelection && index === 0) ? 0 : -1;
      bar.style.borderColor = selected ? '#229ec6' : 'transparent';
      if (labelledUnits !== units) {
        bar.ariaLabel = `${frame.validTime}${elapsed[index] > 1 ? ` · ${elapsed[index]} h after previous shown time` : ''} · ${currentViews[index].summary}`;
        bar.title = bar.ariaLabel;
      }
    });
    labelledUnits = units;
    const selected = bars[selectedIndex];
    if (followSelection && selected && chart.clientWidth > 0) {
      const left = selected.offsetLeft, width = selected.offsetWidth;
      if (width > 0 && Number.isFinite(left + width + chart.scrollLeft + chart.clientWidth)) {
        chart.scrollLeft = Math.max(left + width - chart.clientWidth, Math.min(chart.scrollLeft, left));
        followSelection = false;
      }
    }
  };
  update(options.frameId);
  if (focused) bars.find(bar => bar.value === focused.value)?.focus({ preventScroll: true });
  return update;
}
