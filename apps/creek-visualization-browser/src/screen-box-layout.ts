// Screen rectangles for placing floating labels over the map without covering the panels that
// float over it. Shared by the named creek pins (named-creek-navigation.ts) and the fish barrier
// pins (fish-barrier-pins.ts).

import type SceneView from '@arcgis/core/views/SceneView';

export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Space kept between a label and anything it must not cover, px. */
export const LABEL_GAP_PX = 6;
/** Distance a label's spot must keep from the map's edge, px, so the pill is never cut off. */
export const MAP_EDGE_MARGIN_PX = 8;
/** Panels floating over the map that a label must not hide behind; found on the page each frame. A hidden panel has no box and is skipped. */
const COVERING_PANEL_SELECTORS = ['aside', '[aria-label="Map legend"]', '#imagery-widget', '#dev-tools-toggle', '#fish-barrier-card'];

export function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Screen boxes, relative to the map, of the sidebar, legend, and corner buttons, with a gap around each. */
export function coveringPanelBoxes(view: SceneView): ScreenBox[] {
  const mapBox = view.container?.getBoundingClientRect();
  if (!mapBox) return [];
  const boxes: ScreenBox[] = [];
  // Every match counts: `aside` is the sidebar and, while it is open, the Dev tools panel.
  for (const panel of document.querySelectorAll(COVERING_PANEL_SELECTORS.join(','))) {
    if (panel.getClientRects().length === 0) continue;
    const rect = panel.getBoundingClientRect();
    boxes.push({
      left: rect.left - mapBox.left - LABEL_GAP_PX,
      top: rect.top - mapBox.top - LABEL_GAP_PX,
      right: rect.right - mapBox.left + LABEL_GAP_PX,
      bottom: rect.bottom - mapBox.top + LABEL_GAP_PX,
    });
  }
  return boxes;
}

/** True when the whole box lies on the map, at least the edge margin from every side. */
export function boxFitsOnMap(box: ScreenBox, view: SceneView): boolean {
  return (
    box.left >= MAP_EDGE_MARGIN_PX &&
    box.top >= MAP_EDGE_MARGIN_PX &&
    box.right <= view.width - MAP_EDGE_MARGIN_PX &&
    box.bottom <= view.height - MAP_EDGE_MARGIN_PX
  );
}

/** Right edge of the sidebar, px from the map's left edge; 0 when there is no sidebar on screen. */
export function sidebarRightPx(view: SceneView): number {
  const sidebar = document.querySelector('aside');
  if (!sidebar || sidebar.getClientRects().length === 0) return 0;
  const mapLeft = view.container?.getBoundingClientRect().left ?? 0;
  return sidebar.getBoundingClientRect().right - mapLeft;
}
