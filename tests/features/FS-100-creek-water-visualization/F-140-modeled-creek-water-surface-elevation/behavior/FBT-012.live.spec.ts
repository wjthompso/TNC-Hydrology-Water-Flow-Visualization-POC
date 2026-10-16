import { expect, test } from '../../../../support/browser/esri-response-cache.ts';
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
 * The developer saw a dark seam line and a dry gap across high water on side
 * creek 27714669 (near Creek Segment 007) and clicked it with no water hit.
 */
const SEAM_HOUR_UTC = '2023-01-01T11:00:00Z';
const PRESERVE_EXTENT_ID = 'dangermond-preserve';
const SEAM_TNC_COMID = '27714669';
const SEAM_CLICKS: readonly DeveloperCreekBedClick[] = [
  {
    nearestSegmentId: '27714669-007',
    cameraPose: {
      positionWgs84: [-120.48240485843216, 34.53452023581515, 175.45184628572315],
      headingDegrees: 352.7733530312621,
      tiltDegrees: 80.83684613648961,
    },
    groundWgs84: { longitude: -120.48244790598753, latitude: 34.53526223296189, z: 162.69897971401818 },
  },
];

test("No creek segment stitching failures (cracks between water polygons): At the January 2023 flood peak, neighbouring Creek Segments' modeled water surfaces meet at the same height across their shared boundary, with no step or wall.", async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
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
      }),
    );
    expect(await readModeledSelectedTimeUtcMs(page), 'opening time from the URL').toBe(timeUtcMs);
    await settleScene(page, 'opening-frame');

    for (const junction of junctions) {
      const label = `${junction.upstreamSegmentId}/${junction.downstreamSegmentId}`;
      await moveCameraAndSettle(
        page,
        topDownCameraPose(junction.sharedVertexWgs84, junction.sharedVertexBedElevationM),
        `${label}-camera`,
      );
      await waitForModeledWaterIdle(page);
      await settleScene(page, `${label}-frame`);

      const seam = await readSeam(page);
      for (const segmentId of [junction.upstreamSegmentId, junction.downstreamSegmentId]) {
        if (!seam.waterSegmentIds.includes(segmentId)) {
          const elevationM = await readModeledElevationM(page, segmentId);
          failures.push(
            `Creek Segment ${segmentId} shows no water at ${FLOOD_PEAK_HOUR_UTC} (modeled water-surface elevation ${elevationM ?? 'none'} m).`,
          );
        }
      }

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

    const seamTimeUtcMs = Date.parse(SEAM_HOUR_UTC);
    const seamMissing = missingLocalPipelineOutput({
      extentId: PRESERVE_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: SEAM_TNC_COMID,
      timesUtcMs: [seamTimeUtcMs],
    });
    if (seamMissing) throw new Error(`INCONCLUSIVE: ${seamMissing}`);
    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: PRESERVE_EXTENT_ID,
        timeUtc: SEAM_HOUR_UTC,
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
