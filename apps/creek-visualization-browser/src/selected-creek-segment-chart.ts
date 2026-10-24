// Wires the Selected Creek Segment to the Water-Surface Elevation Chart
// (UCS-279). Both the observed and the modeled experience use this one path;
// each supplies how to read a segment's Time Series.

import type SceneView from '@arcgis/core/views/SceneView';
import {
  bindCreekSegmentSelection,
  type CreekSegmentSelectionState,
  type WaterGraphicSource,
} from './creek-segment-selection';
import {
  createWaterSurfaceElevationChart,
  type WaterSurfaceElevationChartElements,
  type WaterSurfaceElevationChartState,
  type WaterSurfaceElevationSeries,
} from './water-surface-elevation-chart';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import { isWaterLevelUnit, readWaterLevelUnit, saveWaterLevelUnit, type WaterLevelUnit } from './water-level-units';

/** What the chart shows for a segment: its series, or a message saying why there is none yet. */
export type SegmentChartContent =
  | { readonly series: WaterSurfaceElevationSeries }
  | { readonly emptyText: string };

export interface SelectedCreekSegmentChart {
  readonly selection: CreekSegmentSelectionState;
  readonly chart: WaterSurfaceElevationChartState;
  /** Moves the chart's time cursor. Call on every selected-time change. */
  setSelectedTime(timeUtcMs: number): void;
  /**
   * Call after the renderer drew: re-applies the highlight, and reloads the
   * chart when the segment's Time Series changed (a modeled water-year file landed).
   */
  refresh(): void;
  /** Selects a Creek Segment by id, as a click on its water would. */
  selectSegment(segmentId: string | null): void;
}

export function readWaterSurfaceElevationChartElements(): WaterSurfaceElevationChartElements | null {
  const segmentLabel = document.getElementById('wse-chart-segment');
  const sourceLabel = document.getElementById('wse-chart-source');
  const hoverReadout = document.getElementById('wse-chart-hover');
  const plot = document.getElementById('wse-chart-plot');
  const emptyMessage = document.getElementById('wse-chart-empty');
  const overview = document.getElementById('wse-chart-overview');
  const zoomRow = document.getElementById('wse-chart-zoom-row');
  const zoomReadout = document.getElementById('wse-chart-zoom-readout');
  const resetZoomButton = document.getElementById('wse-chart-reset-zoom');
  const currentTime = document.getElementById('wse-chart-current-time');
  const currentValue = document.getElementById('wse-chart-current-value');
  if (
    !currentValue ||
    !segmentLabel ||
    !sourceLabel ||
    !hoverReadout ||
    !plot ||
    !emptyMessage ||
    !overview ||
    !zoomRow ||
    !zoomReadout ||
    !(resetZoomButton instanceof HTMLButtonElement)
  ) {
    return null;
  }
  return {
    segmentLabel,
    sourceLabel,
    hoverReadout,
    plot,
    emptyMessage,
    overview,
    zoomRow,
    zoomReadout,
    resetZoomButton,
    currentTime,
    currentValue,
  };
}

/**
 * Binds the WSE (m NAVD88) / WSE (ft NAVD88) buttons. The choice is
 * remembered across reloads and Dataset switches.
 */
function bindWaterLevelUnitToggle(
  onChange: (unit: WaterLevelUnit) => void,
  lifetime: ExperienceLifetime,
): WaterLevelUnit {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-water-level-unit]')];
  let current = readWaterLevelUnit();
  const render = (): void => {
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.waterLevelUnit === current));
    }
  };
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const next = button.dataset.waterLevelUnit;
      if (!isWaterLevelUnit(next) || next === current) return;
      current = next;
      saveWaterLevelUnit(current);
      render();
      onChange(current);
    }, { signal: lifetime.signal });
  }
  render();
  return current;
}

export function bindSelectedCreekSegmentChart(input: {
  view: SceneView;
  waterGraphics: WaterGraphicSource;
  chartElements: WaterSurfaceElevationChartElements;
  chartContentForSegment: (segmentId: string) => SegmentChartContent;
  /** Called with the time of the chart reading a person clicked. */
  onChartTimeClicked: (timeUtcMs: number) => void;
  /** Ending it unbinds the click, the chart, and the highlight. */
  lifetime?: ExperienceLifetime;
}): SelectedCreekSegmentChart {
  const lifetime = input.lifetime ?? createExperienceLifetime();
  let chartForToggle: ReturnType<typeof createWaterSurfaceElevationChart> | null = null;
  const initialUnit = bindWaterLevelUnitToggle((unit) => chartForToggle?.setUnit(unit), lifetime);
  const chart = createWaterSurfaceElevationChart(input.chartElements, input.onChartTimeClicked, initialUnit, lifetime);
  chartForToggle = chart;
  let shownContentKey: unknown = null;

  const showContentFor = (segmentId: string | null): void => {
    if (segmentId === null) {
      if (shownContentKey === null) return;
      shownContentKey = null;
      chart.setSeries(null);
      return;
    }
    const content = input.chartContentForSegment(segmentId);
    // Same segment and same arrays means the same picture; skip the redraw.
    const key =
      'series' in content
        ? `${segmentId}|${identityOf(content.series.valuesM)}|${identityOf(content.series.timestampsUtcMs)}`
        : `${segmentId}|${content.emptyText}`;
    if (key === shownContentKey) return;
    shownContentKey = key;
    if ('series' in content) chart.setSeries(content.series);
    else chart.setSeries(null, content.emptyText);
  };

  const selection = bindCreekSegmentSelection(input.view, input.waterGraphics, showContentFor, lifetime);

  return {
    selection,
    chart: chart.state,
    setSelectedTime: (timeUtcMs) => chart.setSelectedTime(timeUtcMs),
    refresh() {
      selection.refresh();
      showContentFor(selection.selectedSegmentId);
    },
    selectSegment: (segmentId) => selection.select(segmentId),
  };
}

/** A stable id per array object, so a reloaded Time Series reads as new content. */
const arrayIds = new WeakMap<object, number>();
let nextArrayId = 1;
function identityOf(array: readonly unknown[]): number {
  let id = arrayIds.get(array);
  if (id === undefined) {
    id = nextArrayId;
    nextArrayId += 1;
    arrayIds.set(array, id);
  }
  return id;
}
