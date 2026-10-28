// Water-Surface Elevation Chart (UCS-279): one Creek Segment's Anchor Water
// Depth over time (UCS-301), drawn as a dependency-free SVG line, with a time cursor
// at the selected time. Hovering reads the value under the pointer without
// changing the time. Clicking selects the time of the nearest reading, which
// the caller passes to the time slider so the map follows.
//
// A range slider under the chart (Plotly style) zooms the time axis: it shows
// the whole record in miniature with the zoom window outlined. Drag a window
// edge to resize it, drag inside it to pan, or drag outside it to brush a new
// window. The depth axis rescales to the readings inside the window, so a
// short outlier fills the chart. Double-click the chart or press Reset zoom to
// show the whole record again.
//
// Optional condition bands (UCS-293) paint red / yellow / green zones behind
// the line, with a hatch over times the zones do not apply to. The chart only
// draws the bands it is given and knows nothing about what they mean.

import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import { formatObservationTime } from './observation-timeline-controls';
import { DEFAULT_WATER_LEVEL_UNIT, formatWaterLevel, type WaterLevelUnit } from './water-level-units';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Room for the depth labels on the left and the date labels below. */
/**
 * `top` leaves a headroom band above the highest reading for the blue value
 * tag on the time cursor, so the tag never covers the line or its peak.
 */
const PLOT_INSET = { left: 54, right: 8, top: 30, bottom: 22 } as const;
/** The cursor value tag sits in the headroom band, this far below the plot's top edge. */
const CURSOR_TAG_TOP = 4;
/** Cursor value tag height and the width of one of its 12 px glyphs (about 0.6 em). */
const CURSOR_TAG_HEIGHT = 20;
const CURSOR_TAG_GLYPH_WIDTH = 7.2;
const CURSOR_TAG_PADDING = 10;
/** The range slider runs full-width — it has no Y-axis labels so it does not need the chart's left margin. */
const OVERVIEW_INSET = { left: 4, right: 4, top: 2, bottom: 2 } as const;
const FALLBACK_SIZE = { width: 300, height: 192 } as const;
const FALLBACK_OVERVIEW_SIZE = { width: 300, height: 40 } as const;
/** A pointer this close to a window edge grabs that edge. */
const HANDLE_GRAB_PX = 7;
/** The zoom window never gets narrower than this many chart pixels' worth of the record. */
const MIN_WINDOW_FRACTION_OF_RECORD = 1 / 2000;
/** The window always spans at least this many readings. */
const MIN_WINDOW_READINGS = 4;
/** Arrow keys move a window edge by this share of the record; Shift moves ten times as far. */
const KEYBOARD_STEP_FRACTION = 0.01;

/** The axis reaches this far above the green edge, so the green zone has some height. */
const BAND_HEADROOM_M = 0.05;
/** A zone label is drawn only when its zone is at least this tall (px). */
const BAND_LABEL_MIN_HEIGHT = 14;

/** A new record's line rises from the plot's bottom edge over this long. */
const LINE_RISE_MS = 600;
/** Turning the zones on or off slides the line, axis, and zones to the new depth range over this long. */
const RANGE_SLIDE_MS = 450;
const BAND_FADE_IN_MS = 350;
const BAND_FADE_OUT_MS = 250;
/** Clicking away from a segment: the old line falls to the plot's bottom edge and fades out over this long. */
const LEAVE_MS = 400;

const easeOutCubic = (progress: number): number => 1 - (1 - progress) ** 3;

const NO_SELECTION_TEXT = 'Click any creek segment on the map to see its water depth over time.';
/** Full instructions live in the chart's info tip (index.html); this is the short idle prompt. */
const HOVER_HINT_TEXT = 'Hover the chart to read a value.';

const axisDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
/** Used on the axis once the window is shorter than this, so its two ends read apart. */
const SHORT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const axisDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export interface WaterSurfaceElevationSeries {
  segmentId: string;
  /** Where the values come from, such as "Observed at USGS gauge 11120600". */
  sourceLabel: string;
  timestampsUtcMs: readonly number[];
  /** Water depth in meters (Anchor Water Depth), parallel to `timestampsUtcMs`. Null is a missing reading. */
  depthM: readonly (number | null)[];
}

/**
 * Red / yellow / green zones for one Creek Segment, as depths above its bed.
 * Below `marginalFromDepthM` is red, up to `suitableFromDepthM` is yellow, and
 * from there up is green.
 */
export interface WaterSurfaceConditionBands {
  /** Names the zones for the chart's label, such as "Adults". */
  stageLabel: string;
  /**
   * The charted value (m) that means zero depth over the bed. It is 0 for a chart of depth above the
   * bed, and above 0 for the observed gauge segment, whose gauge height reads from the gauge datum.
   */
  zeroDepthChartValueM: number;
  marginalFromDepthM: number;
  suitableFromDepthM: number;
  /** True for times the zones do not apply to; the chart hatches them. */
  isOutOfSeason(timeUtcMs: number): boolean;
  /** Short class text for a charted reading, appended to the hover readout; empty for none. */
  describe(chartValueM: number, timeUtcMs: number): string;
}

export interface WaterSurfaceElevationChartElements {
  segmentLabel: HTMLElement;
  sourceLabel: HTMLElement;
  hoverReadout: HTMLElement;
  plot: HTMLElement;
  /** Grayed overlay above the plot while there are no values; it holds `emptyMessage`, the creek, and the arrow. */
  emptyState: HTMLElement;
  emptyMessage: HTMLElement;
  /** Range slider under the plot. */
  overview: HTMLElement;
  /** Row holding the zoom readout and the reset button. */
  zoomRow: HTMLElement;
  zoomReadout: HTMLElement;
  resetZoomButton: HTMLButtonElement;
  /** Optional time label for the value; the page shows the time in the slider readout instead. */
  currentTime?: HTMLElement | null;
  /** Water level at the selected time, next to the slider readout. */
  currentValue: HTMLElement;
}

/** Read-only chart state for the page test seam. */
export interface WaterSurfaceElevationChartState {
  readonly segmentId: string | null;
  readonly pointCount: number;
  /** First and last timestamp of the whole series. */
  readonly domainUtcMs: readonly [number, number] | null;
  /** First and last time the plot shows now; equals `domainUtcMs` until a person zooms. */
  readonly viewWindowUtcMs: readonly [number, number] | null;
  readonly isZoomed: boolean;
  /** Selected time while the cursor is drawn; null when it is outside the shown window or hidden. */
  readonly cursorTimeUtcMs: number | null;
  /** Time of the reading under the pointer; null when the pointer is not over the chart. */
  readonly hoverTimeUtcMs: number | null;
  /** The reading the selected time resolves to, m depth; null when the selected time has none. */
  readonly selectedValueM: number | null;
  readonly unit: WaterLevelUnit;
  /** Stage label of the condition bands drawn now; null when none are drawn. */
  readonly conditionBandsStageLabel: string | null;
  /** Viewport pixel of the line at the reading nearest the time; null when it cannot be drawn. */
  clientPointForTime(timeUtcMs: number): { x: number; y: number } | null;
  /** Viewport pixel of the range slider at a time, for dragging the zoom window. */
  overviewClientXForTime(timeUtcMs: number): number | null;
  /** The reading nearest the time, the one a click there selects. */
  nearestReading(timeUtcMs: number): { timeUtcMs: number; valueM: number } | null;
}

export interface WaterSurfaceElevationChart {
  /** Shows a series, or the empty message when `series` is null. */
  setSeries(series: WaterSurfaceElevationSeries | null, emptyText?: string): void;
  setSelectedTime(timeUtcMs: number): void;
  /** Relabels the axis, readouts, and cursor value; the line itself does not change. */
  setUnit(unit: WaterLevelUnit): void;
  /** Draws condition bands behind the line; null removes them. */
  setConditionBands(bands: WaterSurfaceConditionBands | null): void;
  readonly state: WaterSurfaceElevationChartState;
}

/**
 * The value shown for the selected time: the reading at or before it, held for
 * at most 1.5 reading steps, the same way the map holds a value. Beyond that
 * there is no reading, and the map shows no water either.
 */
function heldReadingIndex(series: PreparedSeries, timeUtcMs: number): number {
  const timestamps = series.timestampsUtcMs;
  let index = lowerBound(timestamps, timeUtcMs);
  if (index >= timestamps.length || timestamps[index] > timeUtcMs) index -= 1;
  if (index < 0) return -1;
  if (timeUtcMs - timestamps[index] > series.stepMs * 1.5) return -1;
  return isFiniteNumber(series.depthM[index]) ? index : -1;
}

interface PreparedSeries extends WaterSurfaceElevationSeries {
  firstUtcMs: number;
  lastUtcMs: number;
  minM: number;
  maxM: number;
  /** Typical spacing between readings, for the narrowest zoom window. */
  stepMs: number;
}

interface TimeWindow {
  startUtcMs: number;
  endUtcMs: number;
}

interface ValueRange {
  minM: number;
  maxM: number;
}

interface PlotFrame {
  width: number;
  height: number;
  plotWidth: number;
  plotHeight: number;
}

type OverviewDrag =
  | { kind: 'start' | 'end' }
  | { kind: 'pan'; anchorUtcMs: number; startWindow: TimeWindow }
  | { kind: 'brush'; anchorUtcMs: number };

export function createWaterSurfaceElevationChart(
  elements: WaterSurfaceElevationChartElements,
  onSelectTime: (timeUtcMs: number) => void,
  initialUnit: WaterLevelUnit = DEFAULT_WATER_LEVEL_UNIT,
  lifetime: ExperienceLifetime = createExperienceLifetime(),
): WaterSurfaceElevationChart {
  const listening = { signal: lifetime.signal };
  let unit: WaterLevelUnit = initialUnit;
  let series: PreparedSeries | null = null;
  let view: TimeWindow = { startUtcMs: 0, endUtcMs: 1 };
  let visibleRange: ValueRange = { minM: 0, maxM: 1 };
  let selectedTimeUtcMs: number | null = null;
  let cursorTimeUtcMs: number | null = null;
  let hoverTimeUtcMs: number | null = null;
  let conditionBands: WaterSurfaceConditionBands | null = null;
  let frame: PlotFrame = measureFrame(elements.plot, PLOT_INSET, FALLBACK_SIZE);
  let overviewFrame: PlotFrame = measureFrame(elements.overview, OVERVIEW_INSET, FALLBACK_OVERVIEW_SIZE);
  let drag: OverviewDrag | null = null;
  let renderHandle: number | null = null;

  // Motion state. The chart draws what these say on every frame, so a tween is a loop that moves a number
  // from one value to another and redraws. Zooming and dragging never use them; those stay instant.
  /** 0 draws the line flat on the plot's bottom edge, 1 draws it in full. */
  let lineRise = 1;
  let riseStartedMs: number | null = null;
  /** The depth range on screen when the zones turned on or off; the slide starts here. */
  let rescaleFrom: ValueRange | null = null;
  let rescaleProgress = 1;
  let rescaleStartedMs: number | null = null;
  let motionHandle: number | null = null;
  const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Main plot -----------------------------------------------------------
  const svg = createSvgElement('svg', { class: 'block h-full w-full overflow-visible' });
  svg.setAttribute('aria-hidden', 'true');
  const axisGroup = createSvgElement('g', {});
  const bandGroup = createSvgElement('g', {});
  const line = createSvgElement('path', {
    class: 'fill-none stroke-cyan-300',
    'stroke-width': '1.5',
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  });
  const cursor = createSvgElement('line', { class: 'stroke-amber-400', 'stroke-width': '2' });
  cursor.id = 'wse-chart-time-cursor';
  // Blue value tag above the cursor: the water level at the selected time.
  const cursorTag = createSvgElement('g', {});
  cursorTag.id = 'wse-chart-cursor-value';
  const cursorTagBox = createSvgElement('rect', { class: 'fill-slate-950/90 stroke-sky-400/70', rx: '3', height: String(CURSOR_TAG_HEIGHT) });
  const cursorTagText = createSvgElement('text', {
    class: 'fill-sky-300 text-xs font-semibold',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
  });
  const cursorDot = createSvgElement('circle', { class: 'fill-sky-300 stroke-slate-950', r: '3' });
  cursorTag.append(cursorTagBox, cursorTagText);
  const hoverLine = createSvgElement('line', {
    class: 'stroke-slate-300',
    'stroke-width': '1',
    'stroke-dasharray': '3 3',
  });
  const hoverDot = createSvgElement('circle', { class: 'fill-cyan-100 stroke-slate-900', r: '3' });
  svg.append(bandGroup, axisGroup, line, cursor, cursorDot, hoverLine, hoverDot, cursorTag);
  elements.plot.append(svg);

  // --- Range slider --------------------------------------------------------
  const overviewSvg = createSvgElement('svg', { class: 'block h-full w-full overflow-visible' });
  const overviewLine = createSvgElement('path', {
    class: 'fill-none stroke-cyan-300/60',
    'stroke-width': '1',
  });
  const overviewCursor = createSvgElement('line', { class: 'stroke-amber-400/80', 'stroke-width': '1' });
  const shadeBefore = createSvgElement('rect', { class: 'fill-slate-950/70' });
  const shadeAfter = createSvgElement('rect', { class: 'fill-slate-950/70' });
  const windowFrame = createSvgElement('rect', {
    // With no values the slider is inert: its frame stays drawn in light gray and ignores the pointer
    // (the group is #wse-chart-overview).
    class:
      'cursor-grab fill-transparent stroke-cyan-200/80 transition-[stroke] duration-300 motion-reduce:transition-none group-data-[empty=true]:pointer-events-none group-data-[empty=true]:stroke-slate-400/70',
    'stroke-width': '1',
    rx: '2',
  });
  const startHandle = createHandle('Zoom window start');
  const endHandle = createHandle('Zoom window end');
  overviewSvg.append(overviewLine, overviewCursor, shadeBefore, shadeAfter, windowFrame, startHandle, endHandle);
  elements.overview.append(overviewSvg);

  // --- Coordinate mapping ----------------------------------------------------
  const viewSpanMs = (): number => view.endUtcMs - view.startUtcMs || 1;

  const xForTime = (timeUtcMs: number): number =>
    PLOT_INSET.left + ((timeUtcMs - view.startUtcMs) / viewSpanMs()) * frame.plotWidth;

  const timeForX = (x: number): number => {
    const fraction = clamp((x - PLOT_INSET.left) / (frame.plotWidth || 1), 0, 1);
    return view.startUtcMs + fraction * viewSpanMs();
  };

  const yForValue = (valueM: number): number => {
    const span = visibleRange.maxM - visibleRange.minM || 1;
    const fraction = (valueM - visibleRange.minM) / span;
    return PLOT_INSET.top + (1 - fraction) * frame.plotHeight;
  };

  /** The line's own y: while a new record rises, every reading is pulled toward the plot's bottom edge. */
  const lineYForValue = (valueM: number): number => {
    const bottom = PLOT_INSET.top + frame.plotHeight;
    return bottom - (bottom - yForValue(valueM)) * lineRise;
  };

  const domainSpanMs = (): number => (series ? series.lastUtcMs - series.firstUtcMs || 1 : 1);

  const overviewXForTime = (timeUtcMs: number): number => {
    if (!series) return OVERVIEW_INSET.left;
    return OVERVIEW_INSET.left + ((timeUtcMs - series.firstUtcMs) / domainSpanMs()) * overviewFrame.plotWidth;
  };

  const overviewTimeForX = (x: number): number => {
    if (!series) return 0;
    const fraction = clamp((x - OVERVIEW_INSET.left) / (overviewFrame.plotWidth || 1), 0, 1);
    return series.firstUtcMs + fraction * domainSpanMs();
  };

  const overviewYForValue = (valueM: number): number => {
    if (!series) return OVERVIEW_INSET.top;
    const span = series.maxM - series.minM || 1;
    const fraction = (valueM - series.minM) / span;
    return OVERVIEW_INSET.top + (1 - fraction) * overviewFrame.plotHeight;
  };

  const nearestReading = (timeUtcMs: number): { timeUtcMs: number; valueM: number } | null => {
    if (!series) return null;
    const index = nearestFiniteIndex(series, timeUtcMs);
    if (index < 0) return null;
    return { timeUtcMs: series.timestampsUtcMs[index], valueM: series.depthM[index] as number };
  };

  // --- Zoom window -----------------------------------------------------------
  const minWindowMs = (): number =>
    series ? Math.max(series.stepMs * MIN_WINDOW_READINGS, domainSpanMs() * MIN_WINDOW_FRACTION_OF_RECORD) : 1;

  const isZoomed = (): boolean =>
    series !== null && (view.startUtcMs > series.firstUtcMs || view.endUtcMs < series.lastUtcMs);

  /** Keeps the window inside the record and at least the minimum width. */
  const clampWindow = (next: TimeWindow, keep: 'start' | 'end' | 'span'): TimeWindow => {
    if (!series) return next;
    const first = series.firstUtcMs;
    const last = series.lastUtcMs;
    const minimum = Math.min(minWindowMs(), last - first);
    if (keep === 'span') {
      const span = clamp(next.endUtcMs - next.startUtcMs, minimum, last - first);
      const start = clamp(next.startUtcMs, first, last - span);
      return { startUtcMs: start, endUtcMs: start + span };
    }
    let start = clamp(next.startUtcMs, first, last);
    let end = clamp(next.endUtcMs, first, last);
    if (end - start < minimum) {
      if (keep === 'start') start = Math.max(first, end - minimum);
      else end = Math.min(last, start + minimum);
      if (end - start < minimum) {
        if (keep === 'start') end = start + minimum;
        else start = end - minimum;
      }
    }
    return { startUtcMs: start, endUtcMs: end };
  };

  const setView = (next: TimeWindow): void => {
    view = next;
    scheduleRender();
  };

  const resetView = (): void => {
    if (!series) return;
    setView({ startUtcMs: series.firstUtcMs, endUtcMs: series.lastUtcMs });
  };

  // --- Drawing ---------------------------------------------------------------
  const hide = (element: SVGElement): void => element.setAttribute('visibility', 'hidden');
  const showVertical = (element: SVGLineElement, x: number, top: number, bottom: number): void => {
    element.setAttribute('x1', String(x));
    element.setAttribute('x2', String(x));
    element.setAttribute('y1', String(top));
    element.setAttribute('y2', String(bottom));
    element.setAttribute('visibility', 'visible');
  };

  const selectedValueM = (): number | null => {
    if (!series || selectedTimeUtcMs === null) return null;
    const index = heldReadingIndex(series, selectedTimeUtcMs);
    return index < 0 ? null : (series.depthM[index] as number);
  };

  /** Time and value under the chart; always shown while a series is loaded, zoomed or not. */
  const drawCurrentReadout = (): void => {
    if (!series || selectedTimeUtcMs === null) {
      if (elements.currentTime) elements.currentTime.textContent = '';
      elements.currentValue.textContent = '';
      return;
    }
    const valueM = selectedValueM();
    if (elements.currentTime) elements.currentTime.textContent = formatObservationTime(selectedTimeUtcMs);
    elements.currentValue.textContent = valueM === null ? 'No reading' : formatWaterLevel(valueM, unit);
  };

  const hideCursorTag = (): void => {
    hide(cursorTag);
    hide(cursorDot);
  };

  const drawCursor = (): void => {
    drawCurrentReadout();
    const time = selectedTimeUtcMs;
    if (!series || time === null || time < series.firstUtcMs || time > series.lastUtcMs) {
      cursorTimeUtcMs = null;
      hide(cursor);
      hide(overviewCursor);
      hideCursorTag();
      return;
    }
    showVertical(
      overviewCursor,
      overviewXForTime(time),
      OVERVIEW_INSET.top,
      OVERVIEW_INSET.top + overviewFrame.plotHeight,
    );
    if (time < view.startUtcMs || time > view.endUtcMs) {
      cursorTimeUtcMs = null;
      hide(cursor);
      hideCursorTag();
      return;
    }
    cursorTimeUtcMs = time;
    const x = xForTime(time);
    // The cursor runs up into the headroom band so the value tag sits on top of it.
    showVertical(cursor, x, CURSOR_TAG_TOP + CURSOR_TAG_HEIGHT, PLOT_INSET.top + frame.plotHeight);
    const valueM = selectedValueM();
    if (valueM === null) {
      hideCursorTag();
      return;
    }
    cursorDot.setAttribute('cx', String(x));
    cursorDot.setAttribute('cy', String(lineYForValue(valueM)));
    cursorDot.setAttribute('visibility', 'visible');
    const label = formatWaterLevel(valueM, unit);
    cursorTagText.textContent = label;
    // Kept inside the plot so it never clips at an edge.
    const width = label.length * CURSOR_TAG_GLYPH_WIDTH + CURSOR_TAG_PADDING;
    const left = clamp(x - width / 2, PLOT_INSET.left, PLOT_INSET.left + frame.plotWidth - width);
    cursorTagBox.setAttribute('x', String(left));
    cursorTagBox.setAttribute('y', String(CURSOR_TAG_TOP));
    cursorTagBox.setAttribute('width', String(width));
    cursorTagText.setAttribute('x', String(left + width / 2));
    cursorTagText.setAttribute('y', String(CURSOR_TAG_TOP + CURSOR_TAG_HEIGHT / 2));
    cursorTag.setAttribute('visibility', 'visible');
  };

  const clearHover = (): void => {
    hoverTimeUtcMs = null;
    hide(hoverLine);
    hide(hoverDot);
    elements.hoverReadout.textContent = series ? HOVER_HINT_TEXT : '';
  };

  const drawHover = (reading: { timeUtcMs: number; valueM: number }): void => {
    hoverTimeUtcMs = reading.timeUtcMs;
    const x = xForTime(reading.timeUtcMs);
    showVertical(hoverLine, x, PLOT_INSET.top, PLOT_INSET.top + frame.plotHeight);
    hoverDot.setAttribute('cx', String(x));
    hoverDot.setAttribute('cy', String(lineYForValue(reading.valueM)));
    hoverDot.setAttribute('visibility', 'visible');
    const parts = [formatObservationTime(reading.timeUtcMs), formatWaterLevel(reading.valueM, unit)];
    if (conditionBands) {
      parts.push(`depth over bed ${formatWaterLevel(reading.valueM - conditionBands.zeroDepthChartValueM, unit)}`);
      const condition = conditionBands.describe(reading.valueM, reading.timeUtcMs);
      if (condition) parts.push(condition);
    }
    elements.hoverReadout.textContent = parts.join(' · ');
  };

  const renderMain = (): void => {
    frame = measureFrame(elements.plot, PLOT_INSET, FALLBACK_SIZE);
    svg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
    axisGroup.replaceChildren();
    if (!series) {
      line.setAttribute('d', '');
      bandGroup.replaceChildren();
      // Empty axes with no values keep the plot's shape; the empty-state overlay grays and explains them.
      axisGroup.append(...emptyAxisElements(frame, unit));
      mirrorEmptyAxisMargin(axisGroup, frame.width);
      hide(cursor);
      hideCursorTag();
      cursorTimeUtcMs = null;
      drawCurrentReadout();
      clearHover();
      return;
    }
    let targetRange = valueRangeIn(series, view) ?? { minM: series.minM, maxM: series.maxM };
    // With bands on, the axis reaches the bed and a little past the green edge, so every zone shows.
    if (conditionBands) targetRange = rangeIncludingBands(targetRange, conditionBands);
    // While the zones turn on or off, the drawn range slides from the old one to the target, and the line,
    // axis labels, and zones all follow it.
    visibleRange =
      rescaleFrom && rescaleProgress < 1
        ? {
            minM: rescaleFrom.minM + (targetRange.minM - rescaleFrom.minM) * rescaleProgress,
            maxM: rescaleFrom.maxM + (targetRange.maxM - rescaleFrom.maxM) * rescaleProgress,
          }
        : targetRange;
    const bandsToDraw = conditionBands ?? fadingBands;
    bandGroup.replaceChildren(...(bandsToDraw ? bandElements(bandsToDraw, view, frame, yForValue) : []));
    cursor.setAttribute('class', conditionBands ? 'stroke-white' : 'stroke-amber-400');
    axisGroup.append(...axisElements(view, visibleRange, frame, yForValue, unit));
    line.setAttribute('d', linePath(series, view, PLOT_INSET.left, frame.plotWidth, lineYForValue));
    drawCursor();
    clearHover();
  };

  const renderOverview = (): void => {
    overviewFrame = measureFrame(elements.overview, OVERVIEW_INSET, FALLBACK_OVERVIEW_SIZE);
    overviewSvg.setAttribute('viewBox', `0 0 ${overviewFrame.width} ${overviewFrame.height}`);
    if (!series) {
      overviewLine.setAttribute('d', '');
      // No values: the window still shows its frame and both handles across the whole width, in the
      // disabled gray (see setSliderEnabled), so people see the zoom control that a selection will switch on.
      const emptyHeight = overviewFrame.height;
      const emptyLeft = OVERVIEW_INSET.left;
      const emptyRight = OVERVIEW_INSET.left + overviewFrame.plotWidth;
      setRect(shadeBefore, emptyLeft, 0, 0, emptyHeight);
      setRect(shadeAfter, emptyRight, 0, 0, emptyHeight);
      setRect(windowFrame, emptyLeft, 0.5, Math.max(1, emptyRight - emptyLeft), emptyHeight - 1);
      placeHandle(startHandle, emptyLeft, emptyHeight, view.startUtcMs);
      placeHandle(endHandle, emptyRight, emptyHeight, view.endUtcMs);
      return;
    }
    overviewLine.setAttribute(
      'd',
      linePath(
        series,
        { startUtcMs: series.firstUtcMs, endUtcMs: series.lastUtcMs },
        OVERVIEW_INSET.left,
        overviewFrame.plotWidth,
        overviewYForValue,
      ),
    );
    const top = 0;
    const height = overviewFrame.height;
    const left = OVERVIEW_INSET.left;
    const right = OVERVIEW_INSET.left + overviewFrame.plotWidth;
    const startX = overviewXForTime(view.startUtcMs);
    const endX = overviewXForTime(view.endUtcMs);
    setRect(shadeBefore, left, top, Math.max(0, startX - left), height);
    setRect(shadeAfter, endX, top, Math.max(0, right - endX), height);
    setRect(windowFrame, startX, top + 0.5, Math.max(1, endX - startX), height - 1);
    placeHandle(startHandle, startX, height, view.startUtcMs);
    placeHandle(endHandle, endX, height, view.endUtcMs);
  };

  const renderZoomRow = (): void => {
    const zoomed = isZoomed();
    elements.resetZoomButton.disabled = !zoomed;
    elements.zoomReadout.textContent = series
      ? `${zoomed ? 'Zoomed' : 'All'}: ${formatWindowEdge(view.startUtcMs, view)} – ${formatWindowEdge(view.endUtcMs, view)}`
      : '';
  };

  const render = (): void => {
    renderMain();
    renderOverview();
    renderZoomRow();
  };

  /** Coalesces drag updates to one redraw per frame; a year of readings is a full scan. */
  function scheduleRender(): void {
    if (renderHandle !== null) return;
    renderHandle = requestAnimationFrame(() => {
      renderHandle = null;
      render();
    });
  }

  // --- Motion ------------------------------------------------------------------
  /** Advances the line rise and the range slide by one frame, redraws, and asks for the next frame while either runs. */
  function tickMotion(nowMs: number): void {
    motionHandle = null;
    if (riseStartedMs !== null) {
      const progress = clamp((nowMs - riseStartedMs) / LINE_RISE_MS, 0, 1);
      lineRise = easeOutCubic(progress);
      if (progress >= 1) riseStartedMs = null;
    }
    if (rescaleStartedMs !== null) {
      const progress = clamp((nowMs - rescaleStartedMs) / RANGE_SLIDE_MS, 0, 1);
      rescaleProgress = easeOutCubic(progress);
      if (progress >= 1) {
        rescaleStartedMs = null;
        rescaleFrom = null;
        rescaleProgress = 1;
      }
    }
    renderMain();
    if (riseStartedMs !== null || rescaleStartedMs !== null) startMotion();
  }

  function startMotion(): void {
    if (motionHandle === null) motionHandle = requestAnimationFrame(tickMotion);
  }

  /** Jumps both tweens to their end, for reduced motion and for teardown. */
  function finishMotion(): void {
    riseStartedMs = null;
    rescaleStartedMs = null;
    rescaleFrom = null;
    rescaleProgress = 1;
    lineRise = 1;
    if (motionHandle !== null) cancelAnimationFrame(motionHandle);
    motionHandle = null;
  }

  /** Starts the line rising from the plot's bottom edge. */
  function startLineRise(): void {
    if (prefersReducedMotion()) return;
    lineRise = 0;
    riseStartedMs = performance.now();
    rescaleFrom = null;
    rescaleStartedMs = null;
    rescaleProgress = 1;
    startMotion();
  }

  /** The zones that fade out are kept here, drawn at the sliding range, until their fade ends. */
  let fadingBands: WaterSurfaceConditionBands | null = null;
  let fadeOutTimer: ReturnType<typeof setTimeout> | null = null;

  const setBandOpacity = (opacity: number, durationMs: number): void => {
    bandGroup.style.transition = durationMs > 0 ? `opacity ${durationMs}ms ease-out` : 'none';
    bandGroup.style.opacity = String(opacity);
  };

  const clearFadeOut = (): void => {
    if (fadeOutTimer !== null) clearTimeout(fadeOutTimer);
    fadeOutTimer = null;
    fadingBands = null;
  };

  /**
   * Turning the zones on fades them in; turning them off fades them out. Either way the line, axis labels,
   * and zones slide to the new depth range, unless a new record is still rising (the rise already moves the line).
   */
  const changeConditionBands = (next: WaterSurfaceConditionBands | null): void => {
    const previous = conditionBands;
    if (previous === null && next === null) return;
    const animate = series !== null && !prefersReducedMotion();
    if (animate && riseStartedMs === null) {
      rescaleFrom = { ...visibleRange };
      rescaleProgress = 0;
      rescaleStartedMs = performance.now();
    }
    clearFadeOut();
    conditionBands = next;
    if (!animate) {
      setBandOpacity(1, 0);
      render();
      return;
    }
    if (next === null) {
      fadingBands = previous;
      setBandOpacity(1, 0);
      render();
      bandGroup.getBoundingClientRect(); // Commits the opacity so the fade starts from fully shown.
      setBandOpacity(0, BAND_FADE_OUT_MS);
      fadeOutTimer = setTimeout(() => {
        fadeOutTimer = null;
        fadingBands = null;
        bandGroup.replaceChildren();
        setBandOpacity(1, 0);
      }, BAND_FADE_OUT_MS);
    } else if (previous === null) {
      setBandOpacity(0, 0);
      render();
      bandGroup.getBoundingClientRect();
      setBandOpacity(1, BAND_FADE_IN_MS);
    } else {
      // Switching life stage keeps the zones on screen; they slide to their new edges.
      setBandOpacity(1, 0);
      render();
    }
    startMotion();
  };

  // --- Leaving ------------------------------------------------------------------
  // With no series the chart redraws as empty at once, so the old picture would vanish in one frame. Instead
  // the drawn SVG is copied just before that redraw; the copy falls to the plot's bottom edge and fades out on
  // top of the empty chart, then is removed. The chart's own state (point count, selection) is already empty.
  let leavingCopies: SVGSVGElement[] = [];
  let leavingTimer: ReturnType<typeof setTimeout> | null = null;

  const removeLeavingCopies = (): void => {
    if (leavingTimer !== null) clearTimeout(leavingTimer);
    leavingTimer = null;
    for (const copy of leavingCopies) copy.remove();
    leavingCopies = [];
  };

  /** Copies `source` over its own box. `fallFromY` is the y (in the SVG's own units) the line collapses onto. */
  const leaveAsCopy = (source: SVGSVGElement, host: HTMLElement, fallFromY: number, keepRects: boolean): SVGSVGElement => {
    const copy = source.cloneNode(true) as SVGSVGElement;
    // The copy must not repeat the live chart's ids (the time cursor's, for one) or its rectangles.
    for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id');
    if (!keepRects) for (const rect of copy.querySelectorAll('rect')) rect.remove();
    copy.setAttribute('class', 'pointer-events-none absolute inset-0 block h-full w-full overflow-visible');
    copy.style.opacity = '1';
    copy.style.transition = `opacity ${LEAVE_MS}ms ease-in`;
    const copiedLine = copy.querySelector('path');
    if (copiedLine) {
      copiedLine.style.transformOrigin = `0px ${fallFromY}px`;
      copiedLine.style.transition = `transform ${LEAVE_MS}ms ease-in`;
      copiedLine.style.transform = 'scaleY(1)';
    }
    host.append(copy);
    copy.getBoundingClientRect(); // Commits the start state so the transitions run.
    copy.style.opacity = '0';
    if (copiedLine) copiedLine.style.transform = 'scaleY(0)';
    return copy;
  };

  const startLeaving = (): void => {
    removeLeavingCopies();
    if (prefersReducedMotion() || frame.plotWidth <= 0) return;
    leavingCopies = [
      leaveAsCopy(svg, elements.plot, PLOT_INSET.top + frame.plotHeight, true),
      leaveAsCopy(overviewSvg, elements.overview, OVERVIEW_INSET.top + overviewFrame.plotHeight, false),
    ];
    leavingTimer = setTimeout(removeLeavingCopies, LEAVE_MS + 50);
  };

  // --- Main plot input ---------------------------------------------------------
  const readingAtPointer = (event: PointerEvent | MouseEvent): { timeUtcMs: number; valueM: number } | null => {
    const rect = elements.plot.getBoundingClientRect();
    return nearestReading(timeForX(event.clientX - rect.left));
  };

  /** Commits a plotted time. The same time again would redraw the map for nothing. */
  const selectPlottedTime = (timeUtcMs: number | null): void => {
    if (timeUtcMs === null || timeUtcMs === selectedTimeUtcMs) return;
    onSelectTime(timeUtcMs);
  };

  // Set while the primary button is down on the plot, so a drag scrubs the
  // selected time. A move with the button up only draws the hover mark.
  let plotScrubPointerId: number | null = null;

  const endPlotScrub = (event: PointerEvent): void => {
    if (plotScrubPointerId !== event.pointerId) return;
    plotScrubPointerId = null;
    if (elements.plot.hasPointerCapture(event.pointerId)) {
      elements.plot.releasePointerCapture(event.pointerId);
    }
    const rect = elements.plot.getBoundingClientRect();
    const overPlot =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!overPlot) clearHover();
  };

  elements.plot.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    plotScrubPointerId = event.pointerId;
    elements.plot.setPointerCapture(event.pointerId);
    const reading = readingAtPointer(event);
    if (reading) {
      drawHover(reading);
      selectPlottedTime(reading.timeUtcMs);
    }
  }, listening);
  elements.plot.addEventListener('pointermove', (event) => {
    const reading = readingAtPointer(event);
    if (reading) drawHover(reading);
    else if (plotScrubPointerId === null) clearHover();
    if (plotScrubPointerId !== null) selectPlottedTime(reading?.timeUtcMs ?? null);
  }, listening);
  elements.plot.addEventListener('pointerleave', () => {
    if (plotScrubPointerId === null) clearHover();
  }, listening);
  elements.plot.addEventListener('pointerup', endPlotScrub, listening);
  elements.plot.addEventListener('pointercancel', endPlotScrub, listening);
  elements.plot.addEventListener('click', (event) => {
    // Select the reading the hover readout shows. Chrome reports whole-pixel
    // click coordinates but fractional pointer coordinates, and one pixel spans
    // many readings, so recomputing here could pick a different reading.
    selectPlottedTime(hoverTimeUtcMs ?? readingAtPointer(event)?.timeUtcMs ?? null);
  }, listening);
  // Plotly convention: double-click resets the zoom.
  elements.plot.addEventListener('dblclick', resetView, listening);
  elements.resetZoomButton.addEventListener('click', resetView, listening);

  // --- Range slider input ------------------------------------------------------
  const overviewLocalX = (event: PointerEvent): number =>
    event.clientX - elements.overview.getBoundingClientRect().left;

  elements.overview.addEventListener('pointerdown', (event) => {
    if (!series || event.button !== 0) return;
    event.preventDefault();
    const x = overviewLocalX(event);
    const time = overviewTimeForX(x);
    const startX = overviewXForTime(view.startUtcMs);
    const endX = overviewXForTime(view.endUtcMs);
    // Inside a narrow window the edges reach in at most a third of its width, so
    // its middle always pans; from outside, an edge stays grabbable at full reach.
    // The nearer edge wins when both are in reach.
    const inside = x > startX && x < endX;
    const reach = inside ? Math.min(HANDLE_GRAB_PX, (endX - startX) / 3) : HANDLE_GRAB_PX;
    const toStart = Math.abs(x - startX);
    const toEnd = Math.abs(x - endX);
    if (Math.min(toStart, toEnd) <= reach) {
      drag = { kind: toStart <= toEnd ? 'start' : 'end' };
    } else if (inside) {
      drag = { kind: 'pan', anchorUtcMs: time, startWindow: { ...view } };
    } else {
      drag = { kind: 'brush', anchorUtcMs: time };
      setView(clampWindow({ startUtcMs: time, endUtcMs: time }, 'end'));
    }
    elements.overview.setPointerCapture(event.pointerId);
    elements.overview.classList.add('cursor-grabbing');
  }, listening);

  elements.overview.addEventListener('pointermove', (event) => {
    if (!drag || !series) return;
    const time = overviewTimeForX(overviewLocalX(event));
    switch (drag.kind) {
      case 'start':
        setView(clampWindow({ startUtcMs: time, endUtcMs: view.endUtcMs }, 'start'));
        break;
      case 'end':
        setView(clampWindow({ startUtcMs: view.startUtcMs, endUtcMs: time }, 'end'));
        break;
      case 'pan': {
        const shift = time - drag.anchorUtcMs;
        setView(
          clampWindow(
            { startUtcMs: drag.startWindow.startUtcMs + shift, endUtcMs: drag.startWindow.endUtcMs + shift },
            'span',
          ),
        );
        break;
      }
      case 'brush':
        setView(
          clampWindow(
            { startUtcMs: Math.min(drag.anchorUtcMs, time), endUtcMs: Math.max(drag.anchorUtcMs, time) },
            time < drag.anchorUtcMs ? 'start' : 'end',
          ),
        );
        break;
    }
  }, listening);

  const endDrag = (event: PointerEvent): void => {
    if (!drag) return;
    drag = null;
    if (elements.overview.hasPointerCapture(event.pointerId)) {
      elements.overview.releasePointerCapture(event.pointerId);
    }
    elements.overview.classList.remove('cursor-grabbing');
  };
  elements.overview.addEventListener('pointerup', endDrag, listening);
  elements.overview.addEventListener('pointercancel', endDrag, listening);
  elements.overview.addEventListener('dblclick', resetView, listening);

  const onHandleKey = (edge: 'start' | 'end') => (event: KeyboardEvent): void => {
    if (!series) return;
    const step = domainSpanMs() * KEYBOARD_STEP_FRACTION * (event.shiftKey ? 10 : 1);
    const current = edge === 'start' ? view.startUtcMs : view.endUtcMs;
    // Home and End send the edge as far as it can go; clampWindow keeps the minimum width.
    const targets: Record<string, number> = {
      ArrowLeft: current - step,
      ArrowDown: current - step,
      ArrowRight: current + step,
      ArrowUp: current + step,
      Home: series.firstUtcMs,
      End: series.lastUtcMs,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    if (edge === 'start') setView(clampWindow({ startUtcMs: target, endUtcMs: view.endUtcMs }, 'start'));
    else setView(clampWindow({ startUtcMs: view.startUtcMs, endUtcMs: target }, 'end'));
  };
  startHandle.addEventListener('keydown', onHandleKey('start'), listening);
  endHandle.addEventListener('keydown', onHandleKey('end'), listening);

  const resizeObserver = new ResizeObserver(render);
  resizeObserver.observe(elements.plot);
  resizeObserver.observe(elements.overview);
  lifetime.onEnd(() => {
    resizeObserver.disconnect();
    if (renderHandle !== null) cancelAnimationFrame(renderHandle);
    renderHandle = null;
    finishMotion();
    clearFadeOut();
    removeLeavingCopies();
    svg.remove();
    overviewSvg.remove();
    elements.segmentLabel.textContent = '';
    elements.sourceLabel.textContent = '';
    elements.hoverReadout.textContent = '';
    elements.emptyMessage.textContent = '';
    elements.zoomReadout.textContent = '';
    if (elements.currentTime) elements.currentTime.textContent = '';
    elements.currentValue.textContent = '';
    elements.overview.classList.remove('cursor-grabbing');
    // The plot keeps its height; with no chart bound, the overlay stays grayed and says nothing.
    setEmptyState(false);
    setSliderEnabled(false);
  });

  /** Grays the range slider (see the `group-data-[empty=true]` classes) and takes its handles out of the tab order. */
  function setSliderEnabled(enabled: boolean): void {
    elements.overview.dataset.empty = String(!enabled);
    for (const handle of [startHandle, endHandle]) {
      handle.setAttribute('tabindex', enabled ? '0' : '-1');
      handle.setAttribute('aria-disabled', String(!enabled));
    }
  }

  /**
   * The grayed overlay above the plot. `awaitingSelection` adds the bouncing arrow and the small creek that
   * show people where to click; other empty cases (no readings, no bed) show their message without them.
   */
  function setEmptyState(awaitingSelection: boolean): void {
    elements.emptyState.dataset.awaitingSelection = String(awaitingSelection);
  }

  // --- Public API --------------------------------------------------------------
  const setSeries = (next: WaterSurfaceElevationSeries | null, emptyText = NO_SELECTION_TEXT): void => {
    const previous = series;
    series = next ? prepareSeries(next) : null;
    if (next && !series) emptyText = `No water depth readings for Creek Segment ${next.segmentId}.`;
    const awaitingSelection = next === null && emptyText === NO_SELECTION_TEXT;
    // A new segment or a different record resets the zoom; a reload of the same record keeps it.
    const sameRecord =
      previous !== null &&
      series !== null &&
      previous.segmentId === series.segmentId &&
      previous.firstUtcMs === series.firstUtcMs &&
      previous.lastUtcMs === series.lastUtcMs;
    if (series && !sameRecord) {
      view = { startUtcMs: series.firstUtcMs, endUtcMs: series.lastUtcMs };
      startLineRise();
    } else if (!series) {
      finishMotion();
    }
    // Copy the drawn chart before render() empties it, so it can fall away instead of vanishing.
    if (series) removeLeavingCopies();
    else if (previous) startLeaving();
    elements.segmentLabel.textContent = next ? `Creek Segment ${next.segmentId}` : '';
    elements.sourceLabel.textContent = series ? series.sourceLabel : '';
    elements.emptyMessage.textContent = series ? '' : emptyText;
    // The plot, slider, and zoom row stay on screen so the panel never changes height. With no values the
    // overlay grays them; the crosshair cursor only shows when a click would do something.
    // The overlay fades (see its transition-opacity class) rather than toggling display, so it crossfades with the line.
    elements.emptyState.classList.toggle('opacity-0', series !== null);
    setEmptyState(awaitingSelection);
    for (const element of [elements.plot, elements.overview]) {
      element.classList.toggle('cursor-crosshair', series !== null);
    }
    setSliderEnabled(series !== null);
    render();
  };

  setSeries(null);

  return {
    setSeries,
    setSelectedTime(timeUtcMs) {
      selectedTimeUtcMs = timeUtcMs;
      drawCursor();
    },
    setUnit(next) {
      if (next === unit) return;
      unit = next;
      render();
    },
    setConditionBands: changeConditionBands,
    state: {
      get segmentId() {
        return series?.segmentId ?? null;
      },
      get pointCount() {
        return series?.timestampsUtcMs.length ?? 0;
      },
      get domainUtcMs() {
        return series ? ([series.firstUtcMs, series.lastUtcMs] as const) : null;
      },
      get viewWindowUtcMs() {
        return series ? ([view.startUtcMs, view.endUtcMs] as const) : null;
      },
      get isZoomed() {
        return isZoomed();
      },
      get cursorTimeUtcMs() {
        return cursorTimeUtcMs;
      },
      get hoverTimeUtcMs() {
        return hoverTimeUtcMs;
      },
      get selectedValueM() {
        return selectedValueM();
      },
      get unit() {
        return unit;
      },
      get conditionBandsStageLabel() {
        return conditionBands?.stageLabel ?? null;
      },
      clientPointForTime(timeUtcMs) {
        const reading = nearestReading(timeUtcMs);
        if (!series || !reading) return null;
        if (reading.timeUtcMs < view.startUtcMs || reading.timeUtcMs > view.endUtcMs) return null;
        const rect = elements.plot.getBoundingClientRect();
        return { x: rect.left + xForTime(reading.timeUtcMs), y: rect.top + yForValue(reading.valueM) };
      },
      overviewClientXForTime(timeUtcMs) {
        if (!series) return null;
        return elements.overview.getBoundingClientRect().left + overviewXForTime(timeUtcMs);
      },
      nearestReading,
    },
  };
}

/** A focusable edge handle; arrow keys move it, so the zoom works without a mouse. */
function createHandle(label: string): SVGRectElement {
  const handle = createSvgElement('rect', {
    class:
      'cursor-ew-resize fill-cyan-200 stroke-slate-900 outline-none focus-visible:fill-amber-300 hover:fill-cyan-100 transition-[fill] duration-300 motion-reduce:transition-none group-data-[empty=true]:pointer-events-none group-data-[empty=true]:fill-slate-400/70',
    'stroke-width': '1',
    rx: '1.5',
    tabindex: '0',
    role: 'slider',
    'aria-label': label,
  });
  return handle;
}

function placeHandle(handle: SVGRectElement, x: number, height: number, timeUtcMs: number): void {
  const width = 6;
  const handleHeight = Math.max(8, height * 0.7);
  setRect(handle, x - width / 2, (height - handleHeight) / 2, width, handleHeight);
  handle.setAttribute('aria-valuetext', formatObservationTime(timeUtcMs));
}

function setRect(rect: SVGRectElement, x: number, y: number, width: number, height: number): void {
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', String(width));
  rect.setAttribute('height', String(height));
}

function formatWindowEdge(timeUtcMs: number, window: TimeWindow): string {
  return window.endUtcMs - window.startUtcMs < SHORT_WINDOW_MS
    ? axisDateTimeFormatter.format(timeUtcMs)
    : axisDateFormatter.format(timeUtcMs);
}

/** Null when the series has no finite reading to draw. */
function prepareSeries(series: WaterSurfaceElevationSeries): PreparedSeries | null {
  let minM = Number.POSITIVE_INFINITY;
  let maxM = Number.NEGATIVE_INFINITY;
  for (const value of series.depthM) {
    if (!isFiniteNumber(value)) continue;
    minM = Math.min(minM, value);
    maxM = Math.max(maxM, value);
  }
  const timestamps = series.timestampsUtcMs;
  const firstUtcMs = timestamps[0];
  const lastUtcMs = timestamps[timestamps.length - 1];
  if (!Number.isFinite(minM) || firstUtcMs === undefined || lastUtcMs === undefined) return null;
  const stepMs = timestamps.length > 1 ? (lastUtcMs - firstUtcMs) / (timestamps.length - 1) : 1;
  return { ...series, firstUtcMs, lastUtcMs, minM, maxM, stepMs };
}

function measureFrame(
  element: HTMLElement,
  inset: { left: number; right: number; top: number; bottom: number },
  fallback: { width: number; height: number },
): PlotFrame {
  const width = element.clientWidth || fallback.width;
  const height = element.clientHeight || fallback.height;
  return {
    width,
    height,
    plotWidth: Math.max(1, width - inset.left - inset.right),
    plotHeight: Math.max(1, height - inset.top - inset.bottom),
  };
}

/** Index of the first timestamp at or after the time. */
function lowerBound(timestamps: readonly number[], timeUtcMs: number): number {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (timestamps[mid] < timeUtcMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Lowest and highest reading inside the window; null when it holds none. */
function valueRangeIn(series: PreparedSeries, window: TimeWindow): ValueRange | null {
  const timestamps = series.timestampsUtcMs;
  let minM = Number.POSITIVE_INFINITY;
  let maxM = Number.NEGATIVE_INFINITY;
  for (let index = lowerBound(timestamps, window.startUtcMs); index < timestamps.length; index += 1) {
    if (timestamps[index] > window.endUtcMs) break;
    const value = series.depthM[index];
    if (!isFiniteNumber(value)) continue;
    minM = Math.min(minM, value);
    maxM = Math.max(maxM, value);
  }
  return Number.isFinite(minM) ? { minM, maxM } : null;
}

/**
 * One vertical stroke per pixel column, from that column's lowest to highest
 * reading, so a year of 15-minute readings stays a few hundred path commands.
 * Only readings inside the window are drawn. The line connects neighbouring
 * readings and breaks at a missing one: a null value, or a time step more than
 * 1.5 times the typical spacing. Zoomed in, empty columns between two
 * neighbouring readings are bridged, so the line does not break into dots.
 */
function linePath(
  series: PreparedSeries,
  window: TimeWindow,
  left: number,
  plotWidth: number,
  yForValue: (valueM: number) => number,
): string {
  const columnCount = Math.max(1, Math.round(plotWidth));
  const spanMs = window.endUtcMs - window.startUtcMs || 1;
  const maxConnectedStepMs = series.stepMs * 1.5;
  const columnMin = new Array<number>(columnCount).fill(Number.POSITIVE_INFINITY);
  const columnMax = new Array<number>(columnCount).fill(Number.NEGATIVE_INFINITY);
  /** True when the line must not join this column to the previous drawn one. */
  const breaksBefore = new Array<boolean>(columnCount).fill(false);
  const timestamps = series.timestampsUtcMs;
  let previousDrawnTimeUtcMs: number | null = null;
  let pendingBreak = false;
  for (let index = lowerBound(timestamps, window.startUtcMs); index < timestamps.length; index += 1) {
    const timeUtcMs = timestamps[index];
    if (timeUtcMs > window.endUtcMs) break;
    const value = series.depthM[index];
    if (!isFiniteNumber(value)) {
      pendingBreak = true;
      continue;
    }
    const column = clamp(Math.floor(((timeUtcMs - window.startUtcMs) / spanMs) * plotWidth), 0, columnCount - 1);
    const firstInColumn = !Number.isFinite(columnMin[column]);
    const steppedTooFar =
      previousDrawnTimeUtcMs !== null && timeUtcMs - previousDrawnTimeUtcMs > maxConnectedStepMs;
    if (firstInColumn && (pendingBreak || steppedTooFar)) breaksBefore[column] = true;
    pendingBreak = false;
    previousDrawnTimeUtcMs = timeUtcMs;
    columnMin[column] = Math.min(columnMin[column], value);
    columnMax[column] = Math.max(columnMax[column], value);
  }
  const commands: string[] = [];
  let drawing = false;
  for (let column = 0; column < columnCount; column += 1) {
    if (!Number.isFinite(columnMin[column])) continue;
    const x = (left + column + 0.5).toFixed(1);
    const join = drawing && !breaksBefore[column];
    commands.push(`${join ? 'L' : 'M'}${x},${yForValue(columnMax[column]).toFixed(1)}`);
    commands.push(`L${x},${yForValue(columnMin[column]).toFixed(1)}`);
    drawing = true;
  }
  return commands.join('');
}

/**
 * The chart's frame with no values: the high and low rules, each labeled with only the unit ("ft" or "m"),
 * so the empty plot reads as a depth chart before any number exists.
 */
function emptyAxisElements(frame: PlotFrame, unit: WaterLevelUnit): SVGElement[] {
  const left = PLOT_INSET.left;
  const right = left + frame.plotWidth;
  const top = PLOT_INSET.top;
  const bottom = top + frame.plotHeight;
  return [top, bottom].flatMap((y) => [
    createSvgElement('line', { class: 'stroke-slate-700', x1: String(left), x2: String(right), y1: String(y), y2: String(y) }),
    svgText(unit, { x: String(left - 4), y: String(y), 'text-anchor': 'end', 'dominant-baseline': 'middle' }),
  ]);
}

/**
 * Empty state only: shortens each rule so the space after its right end equals the space before the unit
 * label on the left. The rules reach the plot's right edge once values exist. Needs a laid-out SVG to
 * measure the labels; when the chart is hidden (all measurements 0) the rules keep their full length.
 */
function mirrorEmptyAxisMargin(axisGroup: SVGGElement, plotSvgWidth: number): void {
  let leftMargin: number;
  try {
    leftMargin = Math.min(...Array.from(axisGroup.querySelectorAll('text'), (label) => label.getBBox().x));
  } catch {
    return; // Firefox throws when the SVG is not rendered.
  }
  if (!Number.isFinite(leftMargin) || leftMargin <= 0) return;
  for (const rule of axisGroup.querySelectorAll('line')) {
    rule.setAttribute('x2', String(plotSvgWidth - leftMargin));
  }
}

function axisElements(
  window: TimeWindow,
  range: ValueRange,
  frame: PlotFrame,
  yForValue: (valueM: number) => number,
  unit: WaterLevelUnit,
): SVGElement[] {
  const right = PLOT_INSET.left + frame.plotWidth;
  const bottom = PLOT_INSET.top + frame.plotHeight;
  const elements: SVGElement[] = [];
  for (const valueM of [range.maxM, range.minM]) {
    const y = yForValue(valueM);
    elements.push(
      createSvgElement('line', {
        class: 'stroke-slate-700',
        x1: String(PLOT_INSET.left),
        x2: String(right),
        y1: String(y),
        y2: String(y),
      }),
      svgText(formatWaterLevel(valueM, unit), {
        x: String(PLOT_INSET.left - 4),
        y: String(y),
        'text-anchor': 'end',
        'dominant-baseline': 'middle',
      }),
    );
  }
  elements.push(
    svgText(formatWindowEdge(window.startUtcMs, window), {
      x: String(PLOT_INSET.left),
      y: String(bottom + 14),
      'text-anchor': 'start',
    }),
    svgText(formatWindowEdge(window.endUtcMs, window), {
      x: String(right),
      y: String(bottom + 14),
      'text-anchor': 'end',
    }),
  );
  return elements;
}

/** Widens the range to the bed and to just past the green edge. */
function rangeIncludingBands(range: ValueRange, bands: WaterSurfaceConditionBands): ValueRange {
  return {
    minM: Math.min(range.minM, bands.zeroDepthChartValueM),
    maxM: Math.max(range.maxM, bands.zeroDepthChartValueM + bands.suitableFromDepthM + BAND_HEADROOM_M),
  };
}

/** Three zone rectangles across the plot, labels where they fit, and a hatch over out-of-season time. */
function bandElements(
  bands: WaterSurfaceConditionBands,
  window: TimeWindow,
  frame: PlotFrame,
  yForValue: (valueM: number) => number,
): SVGElement[] {
  const left = PLOT_INSET.left;
  const top = PLOT_INSET.top;
  const bottom = top + frame.plotHeight;
  const marginalEdgeY = clamp(yForValue(bands.zeroDepthChartValueM + bands.marginalFromDepthM), top, bottom);
  const suitableEdgeY = clamp(yForValue(bands.zeroDepthChartValueM + bands.suitableFromDepthM), top, bottom);
  const zones = [
    { label: 'Suitable', from: top, to: suitableEdgeY, class: 'fill-green-500/20' },
    { label: 'Marginal', from: suitableEdgeY, to: marginalEdgeY, class: 'fill-yellow-400/20' },
    { label: 'Unsuitable', from: marginalEdgeY, to: bottom, class: 'fill-red-500/20' },
  ];
  const elements: SVGElement[] = [];
  const pattern = createSvgElement('pattern', {
    id: 'wse-chart-out-of-season-hatch',
    width: '6',
    height: '6',
    patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  });
  pattern.append(createSvgElement('rect', { width: '6', height: '6', class: 'fill-slate-950/60' }));
  pattern.append(createSvgElement('line', { x1: '0', y1: '0', x2: '0', y2: '6', class: 'stroke-slate-400/60', 'stroke-width': '2' }));
  const defs = createSvgElement('defs', {});
  defs.append(pattern);
  elements.push(defs);
  for (const zone of zones) {
    const height = zone.to - zone.from;
    if (height <= 0) continue;
    const rect = createSvgElement('rect', {
      class: zone.class,
      x: String(left),
      y: String(zone.from),
      width: String(frame.plotWidth),
      height: String(height),
    });
    elements.push(rect);
    // A label needs room; the stage legend in the sidebar carries the class when the zone is thin.
    if (height >= BAND_LABEL_MIN_HEIGHT) {
      elements.push(
        svgText(zone.label, {
          x: String(left + frame.plotWidth - 4),
          y: String(zone.from + height / 2),
          'text-anchor': 'end',
          'dominant-baseline': 'middle',
          'fill-opacity': '0.8',
        }),
      );
    }
  }
  for (const [startUtcMs, endUtcMs] of outOfSeasonSpans(bands, window)) {
    const x1 = left + ((startUtcMs - window.startUtcMs) / (window.endUtcMs - window.startUtcMs || 1)) * frame.plotWidth;
    const x2 = left + ((endUtcMs - window.startUtcMs) / (window.endUtcMs - window.startUtcMs || 1)) * frame.plotWidth;
    elements.push(
      createSvgElement('rect', {
        fill: 'url(#wse-chart-out-of-season-hatch)',
        x: String(x1),
        y: String(top),
        width: String(Math.max(0, x2 - x1)),
        height: String(frame.plotHeight),
      }),
    );
  }
  return elements;
}

/** Out-of-season stretches inside the window, found by sampling about every 600th of it (at least hourly). */
function outOfSeasonSpans(bands: WaterSurfaceConditionBands, window: TimeWindow): [number, number][] {
  const spans: [number, number][] = [];
  const stepMs = Math.max(60 * 60 * 1000, (window.endUtcMs - window.startUtcMs) / 600);
  let spanStart: number | null = null;
  for (let time = window.startUtcMs; time <= window.endUtcMs + stepMs; time += stepMs) {
    const clamped = Math.min(time, window.endUtcMs);
    const out = bands.isOutOfSeason(clamped);
    if (out && spanStart === null) spanStart = clamped;
    if (!out && spanStart !== null) {
      spans.push([spanStart, clamped]);
      spanStart = null;
    }
    if (clamped === window.endUtcMs) break;
  }
  if (spanStart !== null) spans.push([spanStart, window.endUtcMs]);
  return spans;
}

function svgText(text: string, attributes: Record<string, string>): SVGTextElement {
  const element = createSvgElement('text', { class: 'fill-slate-400 text-xs', ...attributes });
  element.textContent = text;
  return element;
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** Index of the finite reading nearest the time, or -1 when the series has none. */
function nearestFiniteIndex(series: PreparedSeries, timeUtcMs: number): number {
  const timestamps = series.timestampsUtcMs;
  const low = Math.min(lowerBound(timestamps, timeUtcMs), timestamps.length - 1);
  // `low` is the first timestamp at or after the time; walk out both ways to the nearest reading.
  let before = low - 1;
  let after = low;
  while (before >= 0 || after < timestamps.length) {
    const beforeOk = before >= 0 && isFiniteNumber(series.depthM[before]);
    const afterOk = after < timestamps.length && isFiniteNumber(series.depthM[after]);
    if (beforeOk && afterOk) {
      return timeUtcMs - timestamps[before] <= timestamps[after] - timeUtcMs ? before : after;
    }
    if (afterOk) return after;
    if (beforeOk) return before;
    before -= 1;
    after += 1;
  }
  return -1;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
