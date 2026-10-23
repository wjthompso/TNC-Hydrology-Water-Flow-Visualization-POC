// Selected Creek Segment (UCS-279): clicking a Creek Segment's water selects
// that segment and highlights its water. Clicking another segment's water moves
// the selection; clicking where no water is drawn clears it. The highlight is
// re-applied after every redraw, because the renderers replace or drop water
// graphics as the time and the camera change.

import type Graphic from '@arcgis/core/Graphic';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import type GraphicsLayerView from '@arcgis/core/views/layers/GraphicsLayerView';
import HighlightOptions from '@arcgis/core/views/support/HighlightOptions';
import type SceneView from '@arcgis/core/views/SceneView';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';

const SELECTED_CREEK_SEGMENT_HIGHLIGHT_NAME = 'selected-creek-segment';
/** Amber stands apart from the blue water and matches the chart's time cursor. */
const SELECTED_CREEK_SEGMENT_HIGHLIGHT_COLOR = '#fbbf24';

export interface WaterGraphicSource {
  readonly layer: GraphicsLayer;
  graphicForSegment(segmentId: string): Graphic | null;
}

/** Read-only selection state for the page test seam. */
export interface CreekSegmentSelectionState {
  readonly selectedSegmentId: string | null;
  /** Creek Segments whose drawn, visible water carries the selection highlight now. */
  readonly highlightedSegmentIds: readonly string[];
}

export interface CreekSegmentSelection extends CreekSegmentSelectionState {
  /** Re-applies the highlight after the renderer drew new water graphics. */
  refresh(): void;
  /** Selects a Creek Segment by id, as a click on its water would; null clears the selection. */
  select(segmentId: string | null): void;
}

export function bindCreekSegmentSelection(
  view: SceneView,
  waterGraphics: WaterGraphicSource,
  onSelectedSegmentChange: (segmentId: string | null) => void,
  lifetime: ExperienceLifetime = createExperienceLifetime(),
): CreekSegmentSelection {
  const highlightOptions = new HighlightOptions({
    name: SELECTED_CREEK_SEGMENT_HIGHLIGHT_NAME,
    color: SELECTED_CREEK_SEGMENT_HIGHLIGHT_COLOR,
    haloColor: SELECTED_CREEK_SEGMENT_HIGHLIGHT_COLOR,
    haloOpacity: 0.9,
    fillOpacity: 0.25,
  });
  view.highlights.add(highlightOptions);

  let selectedSegmentId: string | null = null;
  let layerView: GraphicsLayerView | null = null;
  /** Every highlight handle not yet removed, so a leaked highlight shows in the test seam. */
  const activeHighlights = new Map<Graphic, __esri.Handle>();

  const refresh = (): void => {
    const graphic = selectedSegmentId ? waterGraphics.graphicForSegment(selectedSegmentId) : null;
    for (const [highlightedGraphic, handle] of activeHighlights) {
      if (highlightedGraphic === graphic) continue;
      handle.remove();
      activeHighlights.delete(highlightedGraphic);
    }
    if (!graphic || !layerView || activeHighlights.has(graphic)) return;
    activeHighlights.set(graphic, layerView.highlight(graphic, { name: SELECTED_CREEK_SEGMENT_HIGHLIGHT_NAME }));
  };

  const select = (segmentId: string | null): void => {
    if (segmentId === selectedSegmentId) return;
    selectedSegmentId = segmentId;
    refresh();
    onSelectedSegmentChange(segmentId);
  };

  void view.whenLayerView(waterGraphics.layer).then((resolved) => {
    if (lifetime.signal.aborted) return;
    layerView = resolved as GraphicsLayerView;
    refresh();
  });

  const clickHandle = view.on('click', (event) => {
    void view
      .hitTest(event, { include: [waterGraphics.layer] })
      .then((result) => select(segmentIdOfFirstWaterHit(result)))
      .catch((error: unknown) => console.error('[creek-segment-selection] hit test failed', error));
  });

  lifetime.onEnd(() => {
    clickHandle.remove();
    selectedSegmentId = null;
    refresh();
    view.highlights.remove(highlightOptions);
  });

  return {
    get selectedSegmentId() {
      return selectedSegmentId;
    },
    get highlightedSegmentIds() {
      const ids: string[] = [];
      for (const graphic of activeHighlights.keys()) {
        const segmentId: unknown = graphic.attributes?.segmentId;
        if (graphic.layer && graphic.visible && typeof segmentId === 'string') ids.push(segmentId);
      }
      return ids.sort();
    },
    refresh,
    select,
  };
}

function segmentIdOfFirstWaterHit(result: __esri.SceneViewHitTestResult): string | null {
  for (const hit of result.results) {
    if (hit.type !== 'graphic') continue;
    const segmentId: unknown = hit.graphic?.attributes?.segmentId;
    if (typeof segmentId === 'string') return segmentId;
  }
  return null;
}
