/** Display dimensions and mark sizes; forecast sampling stays in the scene modules. */
export const WINDGRAM_PRESENTATION = {
  maxWidth: 800,
  plotAspectRatio: 592 / 656,
  minimumPlotHeight: 160,
  top: 46,
  bottomMargin: 45,
  mobileMargins: { left: 52, right: 8 },
  desktopMargins: { left: 80, right: 64 },
  fonts: { family: 'Arial, Helvetica, sans-serif', primary: 12, secondary: 11, lift: 14 },
  strokes: {
    grid: 0.6, isotherm: 0.7, freezing: 1.25, barb: 1.1, lift: 1.5,
    barbRim: 2.1, cloud: 1.4, freezingMark: 1.2,
  },
  glyphs: {
    minimumHorizontalSpacing: 40, minimumVerticalSpacing: 28,
    barbStaffMobile: 22, barbStaffDesktop: 24, calmRadius: 3,
    cloudScale: {
      mobile: { minimum: 0.2, maximum: 0.58, columnDivisor: 60 },
      desktop: { minimum: 0.64, maximum: 1, columnDivisor: 64 },
    },
  },
} as const;

export interface WindgramPresentation {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottomMargin: number;
  plotWidth: number;
  plotHeight: number;
  fonts: typeof WINDGRAM_PRESENTATION.fonts;
  strokes: typeof WINDGRAM_PRESENTATION.strokes;
  glyphs: typeof WINDGRAM_PRESENTATION.glyphs & { barbStaff: number };
}

export interface WindgramPresentationOptions {
  widthPx?: number;
  heightPx?: number;
  compact: boolean;
  /** Already formatted altitude labels, including units when displayed beside each tick. */
  altitudeLabels?: readonly string[];
}

/** Arial digit metrics keep sizing deterministic in browser and static rendering. */
function altitudeLabelWidth(label: string): number {
  return [...label].reduce((width, character) => width + (
    /[0-9]/.test(character) ? 0.556 :
    /[,. ft]/.test(character) ? 0.278 :
    /[−-]/.test(character) ? 0.333 :
    character === 'm' ? 0.833 : 0.6
  ), 0) * WINDGRAM_PRESENTATION.fonts.primary;
}

/** Fit the natural chart aspect to the space the host assigns. */
export function resolveWindgramPresentation(options: WindgramPresentationOptions): WindgramPresentation {
  const style = WINDGRAM_PRESENTATION;
  const width = Math.max(1, Math.min(style.maxWidth,
    Number.isFinite(options.widthPx) ? Math.floor(options.widthPx!) : style.maxWidth));
  const margins = options.compact ? style.mobileMargins : style.desktopMargins;
  const labelWidth = Math.max(0, ...(options.altitudeLabels ?? []).map(altitudeLabelWidth));
  const right = Math.min(margins.right, width - 1);
  // Include the tick gap and a small outer inset. Only unusually wide labels expand the axis.
  const left = Math.min(Math.max(margins.left, Math.ceil(labelWidth + 14)), width - right - 1);
  const plotWidth = width - left - right;
  const naturalHeight = Math.max(style.minimumPlotHeight, Math.round(plotWidth * style.plotAspectRatio));
  const availableHeight = options.heightPx === undefined || !Number.isFinite(options.heightPx)
    ? naturalHeight : Math.floor(options.heightPx) - style.top - style.bottomMargin;
  const plotHeight = Math.max(1, Math.min(naturalHeight, availableHeight));
  return {
    width, left, right, plotWidth, plotHeight,
    top: style.top,
    bottomMargin: style.bottomMargin,
    height: style.top + plotHeight + style.bottomMargin,
    fonts: style.fonts,
    strokes: style.strokes,
    glyphs: { ...style.glyphs, barbStaff: options.compact ? style.glyphs.barbStaffMobile : style.glyphs.barbStaffDesktop },
  };
}
