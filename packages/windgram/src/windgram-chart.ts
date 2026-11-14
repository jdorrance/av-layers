import {
  convertQuantity,
  fahrenheitToCelsius,
  formatQuantity,
  knotsToMps,
  svgNumber as fmt,
  unitLabel,
  type UnitSystem,
} from './windgram-format.ts';
import { CALM_RADIUS, CLOUD_PATH, SNOWFLAKE_PATH, windBarbGlyph, windgramCloudScale } from './windgram-glyphs.ts';
import { displayedBarbSpeed } from './wind-barb.ts';
import { displayedBarbs, layoutWindgramMarks, type PlacedTemperatureLabel } from './windgram-label-layout.ts';
import { WINDGRAM_STABILITY, WINDGRAM_STABLE_COLOR, stabilityRange } from './windgram-stability.ts';
import { heightToY, visibleHeightAnchors } from './windgram-scale.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import { visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramCloud, WindgramView } from './windgram-view.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
const text = (x: number, y: number, value: string, attrs = '') =>
  `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${escape(value)}</text>`;
const altitude = (m: number, system: UnitSystem) => Math.round(convertQuantity(m, 'elevation', system)!).toLocaleString('en-US');
const temperature = (f: number, system: UnitSystem) => convertQuantity(fahrenheitToCelsius(f), 'temperature', system)!;
const barbSpeed = (knots: number, system: UnitSystem) => `${displayedBarbSpeed(knotsToMps(knots), system)} ${unitLabel('wind', system)}`;
const degrees = (direction: number) =>
  `${['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;

const styleTag = (stylesheet?: string) => stylesheet ? `<style>${stylesheet}</style>` : '';

function cloudGlyph(cloud: WindgramCloud, scale: number, system: UnitSystem) {
  return `<g class="wg-cloud-symbol" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})"><title>Potential cloud base (surface LCL) · ${altitude(cloud.baseM, system)} ${unitLabel('elevation', system)} MSL</title><path d="${CLOUD_PATH}" class="wg-cloud-potential"/></g>`;
}

function renderTemperatureLabelsSvg(labels: readonly PlacedTemperatureLabel[]): string {
  return labels
    .map(
      ({ temperatureF, valueText, box, textX, textY, freezing }) =>
        `<g class="wg-temperature-label" data-temperature-f="${temperatureF}"><rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${box.width}" height="${box.height}" rx="2" class="wg-temperature-back"/>${text(textX, textY, valueText, `text-anchor="middle" class="wg-temperature${freezing ? ' wg-temperature-freezing' : ''}"`)}</g>`,
    )
    .join('');
}

function heightAxisHeader(view: WindgramView, system: UnitSystem) {
  const x = view.left - 8;
  return text(x, 16, `${unitLabel('elevation', system)} MSL`, 'text-anchor="end" class="wg-axis-unit"') +
    text(x, 31, 'Lift w*', 'text-anchor="end" class="wg-lift"') +
    text(x, 42, unitLabel('lift', system), 'text-anchor="end" class="wg-axis-unit"');
}

function heightAxisLabels(view: WindgramView, system: UnitSystem) {
  return visibleHeightAnchors(view)
    .map((anchor) => {
      const tick = `<path d="M${view.left - 5} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`;
      return (
        tick +
        (view.compact
          ? text(view.left - 9, anchor.y + 4, altitude(anchor.heightM, system), 'text-anchor="end" class="wg-axis-feet"')
          : text(
              view.left - 10,
              anchor.y - 3,
              anchor.pressureHpa === null ? '' : formatQuantity(anchor.pressureHpa, 'pressure', undefined, system),
              'text-anchor="end" class="wg-axis"',
            ) +
            text(view.left - 10, anchor.y + 12, `${altitude(anchor.heightM, system)} ${unitLabel('elevation', system)}`, 'text-anchor="end" class="wg-axis"'))
      );
    })
    .join('');
}

export function renderWindgramSvg(
  view: WindgramView,
  options: { idPrefix?: string; stylesheet?: string } = {},
): string {
  const system = view.unitSystem;
  const id = identifier(options.idPrefix ?? 'windgram');
  const right = view.left + view.plotWidth;
  const labelX = (x: number) => Math.max(view.left + 12, Math.min(right - 12, x));
  const visibleHours = new Set(visibleWindgramHourIndices({
    hours: view.timeAxis.map(tick => ({ x: labelX(tick.x) })), compact: view.compact,
  }));
  // Cloud outlines show the published parcel base or effective limit.
  const clouds = view.clouds.filter(cloud => cloud.kind === 'potential');
  const cloudScale = windgramCloudScale(view);
  const { barbs, labels } = layoutWindgramMarks(view, cloudScale, clouds,
    displayedBarbs(view, new Set(view.hours.map((_, i) => i))));
  const parts: string[] = [
    styleTag(options.stylesheet),
    `<defs><clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath><pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern><pattern id="${id}-humidity" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M0 8L8 0" fill="none" stroke="#fff" stroke-width=".8" opacity=".75"/></pattern></defs>`,
    `<rect width="${fmt(view.width)}" height="${fmt(view.height)}" rx="6" fill="${WINDGRAM_STABLE_COLOR}"/>`,
    heightAxisHeader(view, system),
    view.compact ? '' : text(right + 12, view.top - 14, `${unitLabel('elevation', system)} MSL`, 'class="wg-axis-unit"'),
    `<g clip-path="url(#${id}-plot)"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="${WINDGRAM_STABLE_COLOR}"/>`,
  ];
  for (const field of view.fields) {
    parts.push(
      `<path d="${escape(field.path)}" class="${escape(field.className)}" fill-rule="evenodd"${field.className === 'windgram-missing' ? ` fill="url(#${id}-missing)"` : ''}/>`,
    );
  }
  const firstData = view.hours[0], lastData = view.hours.at(-1);
  const uncovered =
    firstData && lastData
      ? [
          { x: view.left, width: firstData.x - view.columnWidth / 2 - view.left },
          { x: lastData.x + view.columnWidth / 2, width: right - lastData.x - view.columnWidth / 2 },
        ].filter(span => span.width > 0.01)
      : view.timeAxis.length ? [{ x: view.left, width: view.plotWidth }] : [];
  for (const span of uncovered) {
    parts.push(
      `<rect x="${fmt(span.x)}" y="${view.top}" width="${fmt(span.width)}" height="${fmt(view.plotHeight)}" fill="url(#${id}-missing)" data-forecast-unavailable=""><title>Forecast unavailable for these hours in this run</title></rect>`,
    );
    if (span.width >= 64) parts.push(text(span.x + span.width / 2, view.top + view.plotHeight / 2, 'Unavailable', 'text-anchor="middle" class="wg-unavailable"'));
  }
  for (const band of view.cloudBands) {
    parts.push(
      `<rect x="${fmt(band.x)}" y="${fmt(band.y)}" width="${fmt(band.width)}" height="${fmt(band.height)}" fill="url(#${id}-humidity)" data-cloud-band="humidity"><title>Interpolated relative humidity of at least ${CLOUD_RH_THRESHOLD_PERCENT}%</title></rect>`,
    );
  }
  for (const hour of view.timeAxis) parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-hourline"/>`);
  for (const anchor of view.anchors) parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(anchor.y)}" y2="${fmt(anchor.y)}" class="wg-grid"/>`);
  for (const series of view.series) {
    if (series.path) {
      parts.push(
        `<path d="${escape(series.path)}" fill="none" stroke="${escape(series.color)}" stroke-width="${series.key === 'usableLiftTopM' ? view.presentation.strokes.lift : 1}"${series.dash ? ` stroke-dasharray="${escape(series.dash)}"` : ''} opacity="${series.key === 'usableLiftTopM' ? 1 : 0.55}" data-height-series="${escape(series.key)}"><title>${escape(series.label)}</title></path>`,
      );
    }
    if (series.key === 'usableLiftTopM') {
      for (const hour of view.hours) {
        const z = hour.usableLiftTopM;
        if (z !== null) parts.push(`<circle cx="${fmt(hour.x)}" cy="${fmt(heightToY(view, z))}" r="2" fill="${series.color}" data-map-lift-ceiling=""/>`);
      }
    }
  }
  for (const contour of view.contours) {
    parts.push(
      `<path d="${escape(contour.path)}" class="${contour.temperatureF === 32 ? 'wg-isotherm-freezing' : 'wg-isotherm'}" data-temperature-f="${contour.temperatureF}"/>`,
    );
  }
  for (const barb of barbs) {
    const geometry = windBarbGlyph(barb, view.presentation, system);
    const color = barb.speedKt < 9 ? '#78ff78' : '#ffffff';
    const reference = barb.surface
      ? `Model surface · 10 m above model ground (${formatQuantity(view.sourceHours[barb.hourIndex].modelTerrainM, 'elevation', undefined, system)} MSL)`
      : `${formatQuantity(barb.heightM, 'elevation', undefined, system)} MSL · ${barb.interpolated ? 'Interpolated' : 'Model level'}`;
    const windLabel = geometry.calm ? 'Calm' : `${barbSpeed(barb.speedKt, system)} from ${degrees(barb.directionDeg)}`;
    const title = `${windLabel} · ${reference}`;
    const shape = geometry.calm
      ? `<circle r="${CALM_RADIUS}" class="wg-barb-rim"/><circle r="${CALM_RADIUS}" class="wg-barb"/>`
      : ['wg-barb-rim', 'wg-barb'].map(className =>
        `<path d="${geometry.staff}" class="${className}"/>${geometry.flags.map(flag =>
          `<path d="${flag}" class="${className}"${className === 'wg-barb' && flag.endsWith('Z') ? ' style="fill:currentColor"' : ''}/>`
        ).join('')}`
      ).join('');
    parts.push(
      `<g transform="translate(${fmt(barb.x)} ${fmt(barb.y)})" style="color:${color}" class="${barb.interpolated ? 'wg-barb-interpolated' : 'wg-barb-native'}" data-wind-source="${barb.interpolated ? 'interpolated' : 'native'}"><title>${escape(title)}</title>${shape}</g>`,
    );
  }
  parts.push(renderTemperatureLabelsSvg(labels));
  for (const freeze of view.freezing) {
    parts.push(
      `<path d="${SNOWFLAKE_PATH}" transform="translate(${fmt(freeze.x)} ${fmt(freeze.y)})" class="wg-freezing-mark"><title>Lowest freezing level · ${formatQuantity(0, 'temperature', undefined, system)}</title></path>`,
    );
  }
  // Potential cloud-base symbols are outlines so the lapse-rate color stays visible.
  for (const cloud of clouds) parts.push(cloudGlyph(cloud, cloudScale, system));
  parts.push('</g>');
  parts.push(`<rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="none" stroke="#eeebff" stroke-width="1"/>`);
  parts.push(heightAxisLabels(view, system));
  if (!view.compact) {
    for (const anchor of visibleHeightAnchors(view)) {
      parts.push(`<path d="M${fmt(right)} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`);
      parts.push(text(right + 10, anchor.y + 4, altitude(anchor.heightM, system), 'class="wg-axis-feet"'));
    }
  }
  for (const [axisIndex, tick] of view.timeAxis.entries()) {
    const hour = tick.hourIndex === null ? null : view.hours[tick.hourIndex];
    parts.push(`<line x1="${fmt(tick.x)}" x2="${fmt(tick.x)}" y1="${fmt(view.bottom)}" y2="${fmt(view.bottom + 5)}" stroke="#fff"/>`);
    if (!visibleHours.has(axisIndex)) continue;
    const x = labelX(tick.x);
    parts.push(text(x, 16, tick.label, 'text-anchor="middle" class="wg-hour wg-hour-top"'));
    parts.push(
      text(
        x,
        31,
        hour?.thermalVelocityMps == null ? '—' : `${Number(convertQuantity(hour.thermalVelocityMps, 'lift', system)!.toFixed(system === 'metric' ? 1 : 0))}`,
        'text-anchor="middle" class="wg-lift"',
      ),
    );
    parts.push(text(x, view.bottom + 15, tick.label, 'text-anchor="middle" class="wg-hour"'));
    parts.push(
      text(
        x,
        view.bottom + 28,
        hour?.temperatureF == null ? '—' : `${Math.round(temperature(hour.temperatureF, system))}°`,
        'text-anchor="middle" class="wg-surface-temp"',
      ),
    );
  }
  parts.push(
    text(
      view.left - (view.compact ? 8 : 10),
      view.bottom + 28,
      `${view.compact ? 'Sfc' : 'Surface'} ${unitLabel('temperature', system)}`,
      'text-anchor="end" class="wg-axis-unit"',
    ),
  );
  const referenceTime = view.timeAxis[0]?.validAt ?? view.hours[0]?.validAt;
  const timeZoneLabel = referenceTime
    ? new Intl.DateTimeFormat('en-US', { timeZone: view.timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(referenceTime)).find(part => part.type === 'timeZoneName')?.value ?? view.timeZone
    : view.timeZone;
  const clock = view.timeZone.startsWith('Etc/GMT') ? `${timeZoneLabel} (longitude)` : timeZoneLabel;
  parts.push(text(view.width / 2, view.bottom + 41,
    `${clock} · Wind ${unitLabel('wind', system)} · temperature ${unitLabel('temperature', system)}`,
    'text-anchor="middle" class="wg-axis-unit wg-footer"'));
  parts.push(
    '<g class="wg-inspector" data-windgram-cursor="" visibility="hidden" aria-hidden="true"><line data-cursor-vertical=""/><line data-cursor-horizontal=""/><circle data-cursor-point="" r="7"/><g data-cursor-readout=""><rect data-cursor-back="" height="47" rx="6" class="wg-inspector-back"/><text x="10" y="20" data-cursor-agl="" class="wg-inspector-agl"/><text x="10" y="36" data-cursor-msl="" class="wg-inspector-msl"/></g></g>',
  );
  const first = view.timeAxis[0], last = view.timeAxis.at(-1)!;
  const coverage = uncovered.length && firstData && lastData ? ` Forecast available ${firstData.label}–${lastData.label}; hatched hours unavailable.` : !view.hours.length ? ' Daylight forecast unavailable in this run.' : '';
  const description = `Windgram${first ? ` ${first.label}–${last.label}` : ''} · ${view.timeZone}.${coverage} Height ${unitLabel('elevation', system)} MSL. Wind feathers kt (${unitLabel('wind', system)} readout). Temperature ${unitLabel('temperature', system)}. Lift ${unitLabel('lift', system)}. Crosshatching marks interpolated RH of at least ${CLOUD_RH_THRESHOLD_PERCENT}%. Dark hatching marks unavailable atmosphere. The blue series shows map usable lift.`;
  return `<svg xmlns="${SVG_NS}" width="${fmt(view.width)}" height="${fmt(view.height)}" viewBox="0 0 ${fmt(view.width)} ${fmt(view.height)}" role="img" aria-labelledby="${id}-title ${id}-description" class="windgram${view.compact ? ' windgram-compact' : ''}"><title id="${id}-title">Wind, temperature and clouds by hour and altitude</title><desc id="${id}-description">${escape(description)}</desc>${parts.join('\n')}</svg>`;
}

export function renderWindgramKey(system: UnitSystem, usesDsm = false): string {
  const icon = (content: string, width = 35) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 24" width="${width}" height="24" aria-hidden="true">${content}</svg>`;
  const humidity = icon(
    `<rect x="2" y="1" width="31" height="22" rx="2" fill="${WINDGRAM_STABLE_COLOR}"/><path d="M4 3L22 21M13 3L31 21M4 21L22 3M13 21L31 3" stroke="#fff" stroke-width="1"/>`,
  );
  const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(17 20) scale(.55)" fill="none" stroke="#7773bc" stroke-width="1.7" stroke-dasharray="4 3"/>`);
  const wind = icon('<path d="M9 21L9 3M9 3L20 7M9 8L15 10" fill="none" stroke="#355963" stroke-width="1"/>');
  const freezing = icon(
    `<path d="M1 12H34" stroke="#237d92" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${SNOWFLAKE_PATH}" transform="translate(17 12)" fill="none" stroke="#237d92"/>`,
  );
  const lift = icon('<path d="M1 12H34" stroke="#134ac4" stroke-width="1.5"/><circle cx="17" cy="12" r="2" fill="#134ac4"/>');
  const feathers = 'half 5 / full 10 / flag 50 kt';
  const greenLimit = formatQuantity(knotsToMps(9), 'wind', undefined, system);
  return `<div class="windgram-legend"><div class="windgram-legend-ramp"><strong>Lapse rate · ${unitLabel('lapseRate', system)}</strong>${WINDGRAM_STABILITY.map(({ color }, i) => `<span class="windgram-legend-chip" style="--chip:${color}">${stabilityRange(i, system)}</span>`).join('')}</div><div class="windgram-legend-symbols"><span>${wind}Wind · ${feathers}</span><span>${humidity}RH ≥${CLOUD_RH_THRESHOLD_PERCENT}%</span><span>${potential}Native surface LCL</span><span>${freezing}${formatQuantity(0, 'temperature', undefined, system)} freezing level</span><span>${lift}Map usable lift</span></div><details class="windgram-legend-note"><summary>Chart key</summary><p>Lapse scale from WxToFly. Red and orange mark rapid cooling. Gray marks inversions. Dark hatching marks unavailable atmosphere. Green wind is below ${greenLimit}. Faint barbs are interpolated. Dashed amber is the native parcel top. Dashed teal is the native effective cloud limit. Dashed gray marks fine surface elevation.${usesDsm ? ' The digital surface model (DSM) includes vegetation and buildings.' : ''}</p></details></div>`;
}
