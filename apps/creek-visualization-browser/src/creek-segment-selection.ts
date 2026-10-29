// Selected Creek Segment (UCS-279): clicking a Creek Segment's water selects
// that segment and highlights its water. Clicking another segment's water moves
// the selection; clicking where no water is drawn clears it. The highlight is
// re-applied after every redraw, because the renderers replace or drop water
// graphics as the time and the camera change.

import type Graphic from '@arcgis/core/Graphic';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import type GraphicsLayerView from '@arcgis/core/views/layers/GraphicsLayerView';
import Color from '@arcgis/core/Color';
import HighlightOptions from '@arcgis/core/views/support/HighlightOptions';
import type SceneView from '@arcgis/core/views/SceneView';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';

const SELECTED_CREEK_SEGMENT_HIGHLIGHT_NAME = 'selected-creek-segment';
/** Amber stands apart from the blue water and matches the chart's time cursor. */
const SELECTED_CREEK_SEGMENT_HIGHLIGHT_COLOR = '#fbbf24';
/** White while steelhead trout conditions color the water, because amber reads as the Marginal yellow. */
const TROUT_CONDITIONS_HIGHLIGHT_COLOR = '#ffffff';

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
  /** Switches the highlight to white (steelhead trout conditions on) or back to amber. */
  setTroutConditionsHighlight(on: boolean): void;
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
  /**
   * Every highlight handle not yet removed, so a leaked highlight shows in the test seam. The
   * geometry is the one the highlight was made for: a renderer redraw replaces a graphic's
   * geometry in place, and a highlight made for the old geometry would stay behind.
   */
  const activeHighlights = new Map<Graphic, { handle: __esri.Handle; geometry: Graphic['geometry'] }>();

  const refresh = (): void => {
    const selectedGraphic = selectedSegmentId ? waterGraphics.graphicForSegment(selectedSegmentId) : null;
    // The outline follows drawn water: a hidden graphic (no bucket matches) carries no highlight,
    // and it returns with the water.
    const graphic = selectedGraphic?.visible ? selectedGraphic : null;
    for (const [highlightedGraphic, highlight] of activeHighlights) {
      if (highlightedGraphic === graphic && highlight.geometry === graphic.geometry) continue;
      highlight.handle.remove();
      activeHighlights.delete(highlightedGraphic);
    }
    if (!graphic || !layerView || activeHighlights.has(graphic)) return;
    activeHighlights.set(graphic, {
      handle: layerView.highlight(graphic, { name: SELECTED_CREEK_SEGMENT_HIGHLIGHT_NAME }),
      geometry: graphic.geometry,
    });
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
    setTroutConditionsHighlight(on) {
      const color = on ? TROUT_CONDITIONS_HIGHLIGHT_COLOR : SELECTED_CREEK_SEGMENT_HIGHLIGHT_COLOR;
      highlightOptions.color = new Color(color);
      highlightOptions.haloColor = new Color(color);
    },
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
