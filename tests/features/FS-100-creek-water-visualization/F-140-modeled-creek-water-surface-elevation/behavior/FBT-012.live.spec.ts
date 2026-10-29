import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  readSeam,
  watchLiveServices,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  moveCameraAndSettle,
  settleScene,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';
import {
  finishSceneCheck,
  rethrowSceneFailure,
  watchTerrainTraffic,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-check-outcome.ts';
import {
  JALAMA_EXTENT_ID,
  JALAMA_TNC_COMID,
  NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
  junctionSamplesAt,
  missingLocalPipelineOutput,
  readCrossSections,
  readJunction,
} from './local-pipeline-output.ts';
import {
  formatLonLat,
  hitTestWaterAtPoints,
  modeledWaterPageUrl,
  openModeledWaterPage,
  readModeledElevationM,
  readModeledSelectedTimeUtcMs,
  replayDeveloperClicks,
  topDownCameraPose,
  visibleWaterSurface,
  waitForModeledWaterIdle,
  type DeveloperCreekBedClick,
  type WaterHitSample,
} from './modeled-water-page.ts';

/**
 * Bug Check (Linear UCS-271): at the January 2023 flood peak each Creek
 * Segment's flat terrace meets its neighbour's at a different height, so a
 * step or wall stands across the shared boundary. 046/047 is the Jalama pair
 * with the largest step in the diagnosis (3.05 m); 015/016 follows (2.05 m).
 */
const FLOOD_PEAK_HOUR_UTC = '2023-01-10T01:00:00Z';
const JUNCTIONS: readonly [string, string][] = [
  ['27714637-046', '27714637-047'],
  ['27714637-015', '27714637-016'],
];
/** Creek-bed points this far upstream and downstream of the shared boundary along the thalweg. */
const SAMPLE_OFFSET_M = 1;
/** The surfaces 2 m apart may differ by at most this much in height. */
const MAXIMUM_HEIGHT_DIFFERENCE_M = 0.15;
/** Downstream water may stand at most this much above upstream water. */
const MAXIMUM_INVERSION_M = 0.1;

/**
 * Side creek 27714669 on the Dangermond Preserve extent, on the default modeled pairing: WSE Polygon Generation
 * Method `flowline-channel-ribbon` v2 drawn with the `m5-flowline-profile-jarrett-depth` v1 Time Series.
 *
 * The developer first saw a dark seam line and a dry gap across high water here (near Creek Segment 007, at
 * 2023-01-01T11:00Z) and clicked it with no water hit. Under the default pairing that click lands outside the drawn
 * outline, so it was replaced by the developer's own click on Creek Segment 018's water at 2023-02-01T00:00Z
 * (Jan 31 2023, 4:00 PM PST): 0.164 m of water at the anchor, 0.29 m under the click. The 007 seam is no longer
 * replayed; the developer will add a click of their own if they see another seam.
 */
const SEAM_HOUR_UTC = '2023-02-01T00:00:00Z';
const PRESERVE_EXTENT_ID = 'dangermond-preserve';
const SEAM_TNC_COMID = '27714669';
/** The default pairing's Time Series and ribbon polygons, whose files the page reads at that hour. */
const DEFAULT_MODELED_WSE_VERSION_PATH = 'm5-flowline-profile-jarrett-depth/v1';
const SEAM_RIBBON_POLYGON_SETS_FILE = `04-water-surface-polygons/flowline-channel-ribbon/v2/water-surface-polygon-sets/${SEAM_TNC_COMID}.json`;
const SEAM_CLICKS: readonly DeveloperCreekBedClick[] = [
  {
    nearestSegmentId: '27714669-018',
    cameraPose: {
      positionWgs84: [-120.4822325102055, 34.529780744447905, 155.77706593461335],
      headingDegrees: 5.120392188775799,
      tiltDegrees: 79.15365937641032,
    },
    groundWgs84: { longitude: -120.48210132011081, latitude: 34.53081971100631, z: 132.76909181755036 },
  },
];

test("No creek segment stitching failures (cracks between water polygons): At the January 2023 flood peak, neighbouring Creek Segments' modeled water surfaces meet at the same height across their shared boundary, with no step or wall.", async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    // (1) Jalama flood peak: junctions 27714637-046/047, then 015/016.
    // The page opens on the default saved polygon method (no wsePolygonMethod in the URL).
    const timeUtcMs = Date.parse(FLOOD_PEAK_HOUR_UTC);
    const missing = missingLocalPipelineOutput({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timesUtcMs: [timeUtcMs],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);
    const crossSections = readCrossSections(JALAMA_EXTENT_ID);
    const junctions = JUNCTIONS.map(([a, b]) => readJunction(crossSections, a, b));

    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: JALAMA_EXTENT_ID,
        timeUtc: FLOOD_PEAK_HOUR_UTC,
        imagery: FAST_TEST_SCENE_IMAGERY_ID,
      }),
    );
    expect(await readModeledSelectedTimeUtcMs(page), 'opening time from the URL').toBe(timeUtcMs);
    await settleScene(page, 'opening-frame');

    for (const junction of junctions) {
      const label = `${junction.upstreamSegmentId}/${junction.downstreamSegmentId}`;
      // Camera straight down on the shared boundary, then wait for that frame's water to finish drawing.
      await moveCameraAndSettle(
        page,
        topDownCameraPose(junction.sharedVertexWgs84, junction.sharedVertexBedElevationM),
        `${label}-camera`,
      );
      await waitForModeledWaterIdle(page);
      await settleScene(page, `${label}-frame`);

      // Both creek segments at this junction have to be showing water.
      const seam = await readSeam(page);
      for (const segmentId of [junction.upstreamSegmentId, junction.downstreamSegmentId]) {
        if (!seam.waterSegmentIds.includes(segmentId)) {
          const elevationM = await readModeledElevationM(page, segmentId);
          failures.push(
            `Creek Segment ${segmentId} shows no water at ${FLOOD_PEAK_HOUR_UTC} (modeled water-surface elevation ${elevationM ?? 'none'} m).`,
          );
        }
      }

      // Hit-test 1 m either side of the shared boundary. The two water heights should meet, with no step or wall.
      const [upstreamPoint, downstreamPoint] = junctionSamplesAt(junction, [-SAMPLE_OFFSET_M, SAMPLE_OFFSET_M]);
      if (!upstreamPoint || !downstreamPoint) {
        throw new Error(`The thalweg polyline at ${label} is too short for ${SAMPLE_OFFSET_M} m samples.`);
      }
      const [upstreamHit, downstreamHit] = await hitTestWaterAtPoints(page, [
        { longitude: upstreamPoint.longitude, latitude: upstreamPoint.latitude, z: upstreamPoint.bedElevationM },
        { longitude: downstreamPoint.longitude, latitude: downstreamPoint.latitude, z: downstreamPoint.bedElevationM },
      ]);
      if (!upstreamHit || !downstreamHit) throw new Error(`Hit-testing at ${label} returned no samples.`);

      const upstreamZ = surfaceHeight(upstreamHit);
      const downstreamZ = surfaceHeight(downstreamHit);
      const describe = (side: string, hit: WaterHitSample, z: number | null) =>
        `${side} ${formatLonLat(hit)}: ${z === null ? 'no water surface' : `water surface ${z.toFixed(2)} m`}` +
        ` (${hit.waterHits.map((water) => `${water.segmentId ?? '?'} bucket ${water.bucketMinElevationM ?? '?'}`).join(', ') || 'no water hits'}; ` +
        `drawn surface ${hit.drawnSurfaceElevationM?.toFixed(2) ?? 'none'} m)`;
      const detail = `${describe(`${SAMPLE_OFFSET_M} m upstream`, upstreamHit, upstreamZ)}; ${describe(`${SAMPLE_OFFSET_M} m downstream`, downstreamHit, downstreamZ)}`;

      if (upstreamZ === null || downstreamZ === null) {
        failures.push(
          `At the ${label} boundary at ${FLOOD_PEAK_HOUR_UTC}, no water surface covers the creek bed on both sides. ${detail}.`,
        );
        continue;
      }
      const difference = downstreamZ - upstreamZ;
      if (Math.abs(difference) > MAXIMUM_HEIGHT_DIFFERENCE_M) {
        failures.push(
          `At the ${label} boundary at ${FLOOD_PEAK_HOUR_UTC}, the water surface ${difference < 0 ? 'drops' : 'rises'} ` +
            `${Math.abs(difference).toFixed(2)} m across ${2 * SAMPLE_OFFSET_M} m of creek bed; at most ${MAXIMUM_HEIGHT_DIFFERENCE_M.toFixed(2)} m is allowed. ${detail}.`,
        );
      } else if (difference > MAXIMUM_INVERSION_M) {
        failures.push(
          `At the ${label} boundary at ${FLOOD_PEAK_HOUR_UTC}, downstream water stands ${difference.toFixed(2)} m above upstream water; ` +
            `at most ${MAXIMUM_INVERSION_M.toFixed(2)} m is allowed. ${detail}.`,
        );
      }
    }

    // (2) Dangermond Preserve side creek 27714669 at 2023-02-01T00:00Z: replay the developer click on segment 018's water.
    // The page opens on the default saved polygon method (no wsePolygonMethod in the URL).
    const seamTimeUtcMs = Date.parse(SEAM_HOUR_UTC);
    const seamMissing = missingLocalPipelineOutput({
      extentId: PRESERVE_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: SEAM_TNC_COMID,
      timesUtcMs: [seamTimeUtcMs],
      modeledWseVersionPath: DEFAULT_MODELED_WSE_VERSION_PATH,
      extraRelativePaths: [SEAM_RIBBON_POLYGON_SETS_FILE],
    });
    if (seamMissing) throw new Error(`INCONCLUSIVE: ${seamMissing}`);
    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: PRESERVE_EXTENT_ID,
        timeUtc: SEAM_HOUR_UTC,
        imagery: FAST_TEST_SCENE_IMAGERY_ID,
      }),
    );
    expect(await readModeledSelectedTimeUtcMs(page), 'seam opening time from the URL').toBe(seamTimeUtcMs);
    await settleScene(page, 'seam-opening-frame');
    failures.push(
      ...(await replayDeveloperClicks(page, SEAM_CLICKS, SEAM_HOUR_UTC, async (pose, label) => {
        await moveCameraAndSettle(page, pose, label);
        await waitForModeledWaterIdle(page);
        await settleScene(page, `${label}-frame`);
      })),
    );
    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});

/** Height of the water surface a viewer sees at the sample, m; null when no water is there. */
function surfaceHeight(sample: WaterHitSample): number | null {
  const visible = visibleWaterSurface(sample);
  if (!visible) return null;
  return visible.surfaceElevationM ?? visible.bucketMinElevationM;
}
