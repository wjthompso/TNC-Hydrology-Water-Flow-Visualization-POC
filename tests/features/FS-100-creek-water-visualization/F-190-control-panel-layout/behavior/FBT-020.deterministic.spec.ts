import { expect, test, type Page } from '../../../../support/browser/deterministic-network.ts';
import { timelineFixturePath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';

/**
 * Methodology: Opens the timeline fixture page with the real control panel
 * markup and stylesheet. The ArcGIS scene and published gauge series are not
 * loaded, and the test fails if the page requests ArcGIS. A 1280×300 window
 * stands in for a zoomed-in browser, which shrinks the page's CSS viewport.
 * There, the panel's last line (the imagery credit) starts below the window
 * edge, the panel stays inside the window, and the panel's own scroll area is
 * taller than it is visible. The test then moves the real mouse over the panel
 * and turns the real wheel, and checks that the scroll offset moves and the
 * credit comes inside the window. For the scrollbar, it reads the panel's
 * computed scrollbar color with the pointer away (thumb transparent), over the
 * panel (thumb visible), and away again (transparent). At a 1280×1600 window
 * the panel has no scroll overflow. It does not check the scrollbar's pixels,
 * its look in Firefox or Safari, touch scrolling, or the map.
 */

const ZOOMED_IN_VIEWPORT = { width: 1280, height: 300 } as const;
const TALL_VIEWPORT = { width: 1280, height: 1600 } as const;
const HIDDEN_THUMB_COLOR = 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';

test('Zooming the browser in makes the control panel scroll to its last line, and a thin scrollbar shows only while the pointer is over the panel.', async ({
  page,
}) => {
  const arcgisRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().toLowerCase().includes('arcgis')) arcgisRequests.push(request.url());
  });

  await page.setViewportSize(ZOOMED_IN_VIEWPORT);
  await page.goto(timelineFixturePath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  expect(arcgisRequests, 'The panel check loaded ArcGIS.').toEqual([]);

  const panel = page.locator('#control-panel-scroll');
  const lastLine = page.locator('#scene-note');

  // Pointer away from the panel: content overflows, nothing bleeds, no visible thumb.
  await page.mouse.move(ZOOMED_IN_VIEWPORT.width - 5, ZOOMED_IN_VIEWPORT.height - 5);
  const before = await readPanel(panel, lastLine);
  const beforeDetail = JSON.stringify(before);
  expect(before.scrollHeight, `Panel should overflow. ${beforeDetail}`).toBeGreaterThan(before.clientHeight);
  expect(before.panelBottom, `Panel should stay inside the window. ${beforeDetail}`).toBeLessThanOrEqual(
    ZOOMED_IN_VIEWPORT.height,
  );
  expect(before.lastLineBottom, `Last line should start below the window. ${beforeDetail}`).toBeGreaterThan(
    ZOOMED_IN_VIEWPORT.height,
  );
  expect(before.scrollbarColor, `Thumb should be hidden away from the panel. ${beforeDetail}`).toBe(
    HIDDEN_THUMB_COLOR,
  );

  // Pointer over the panel: thumb becomes visible, and the wheel scrolls.
  await page.mouse.move(100, 100);
  await expect
    .poll(async () => (await readPanel(panel, lastLine)).scrollbarColor, {
      message: 'Thumb should become visible while the pointer is over the panel.',
    })
    .not.toBe(HIDDEN_THUMB_COLOR);

  await page.mouse.wheel(0, 3000);
  await expect
    .poll(async () => (await readPanel(panel, lastLine)).scrollTop, {
      message: 'Wheel over the panel should scroll it.',
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await readPanel(panel, lastLine)).lastLineBottom, {
      message: 'Last line should scroll into the window.',
    })
    .toBeLessThanOrEqual(ZOOMED_IN_VIEWPORT.height);

  // Pointer leaves: thumb hides again.
  await page.mouse.move(ZOOMED_IN_VIEWPORT.width - 5, ZOOMED_IN_VIEWPORT.height - 5);
  await expect
    .poll(async () => (await readPanel(panel, lastLine)).scrollbarColor, {
      message: 'Thumb should hide again after the pointer leaves the panel.',
    })
    .toBe(HIDDEN_THUMB_COLOR);

  // Tall window: everything fits, so there is nothing to scroll.
  await page.setViewportSize(TALL_VIEWPORT);
  await expect
    .poll(async () => {
      const tall = await readPanel(panel, lastLine);
      return tall.scrollHeight - tall.clientHeight;
    }, { message: 'A tall window should show the whole panel without scrolling.' })
    .toBeLessThanOrEqual(0);
});

type PanelReading = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  scrollbarColor: string;
  panelBottom: number;
  lastLineBottom: number;
};

type Locator = ReturnType<Page['locator']>;

async function readPanel(panel: Locator, lastLine: Locator): Promise<PanelReading> {
  const lastLineBottom = await lastLine.evaluate((element) => element.getBoundingClientRect().bottom);
  return panel.evaluate((element, bottom): PanelReading => {
    if (!(element instanceof HTMLElement)) throw new Error('The control panel is missing.');
    return {
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollTop: element.scrollTop,
      scrollbarColor: getComputedStyle(element).scrollbarColor,
      panelBottom: element.getBoundingClientRect().bottom,
      lastLineBottom: bottom,
    };
  }, lastLineBottom);
}
