import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  COMID,
  CROSS_SECTION_BEDS_SNAPSHOT_FILE,
  NEIGHBOUR_POLYGON_SET_PROVENANCE_FILE,
  NEIGHBOUR_POLYGON_SET_SNAPSHOT_FILE,
  OBSERVED_POLYGON_SET_SNAPSHOT_FILE,
  SEGMENT_NETWORK_VERSION,
  FLOWLINE_SNAPSHOT_FILE,
  repositoryRoot,
  sourceInputsDirectory,
} from './constants.ts';
import { readJson, writePrettyJson } from './json-files.ts';
import { propagationNodesById, type CrossSectionBedsSnapshot } from './observed-wse-propagation-publication.ts';
import { OBSERVED_WSE_PROPAGATION, propagatedSegmentsAround } from './observed-wse-propagation.ts';
import { segmentTncFlowline } from './tnc-flowline-segmentation.ts';
import { downstreamVertexDirection } from './modeled-water-surface-elevation/stage-file-formats.ts';

/**
 * Retains the two tracked inputs observed WSE propagation (UCS-300) needs beyond the gauge segment:
 *
 * - the Stage 1 representative bed of every Creek Segment on the gauge's flowline, with Stage 1's
 *   flow-direction verdict, and
 * - Stage 4's prepared water-surface polygon sets for the gauge segment's neighbours within
 *   `OBSERVED_WSE_PROPAGATION.hopsPerDirection` segments, in the published file's shape.
 *
 * Both come from the git-ignored jalama-gauge-reach working output. Run it again only to refresh
 * them on purpose, after rerunning `npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach`:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     pipelines/creek-visualization-data-production/retain-observed-wse-propagation-inputs.ts
 */

const EXTENT_OUTPUT = path.join(repositoryRoot, 'data/pipeline-working-output/jalama-gauge-reach');
const METHOD_ID = 'junction-sloped-terrain-fill';
const METHOD_VERSION = 1;
const STAGE_4_COMMAND = 'npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach';

interface CrossSectionsFileShape {
  segmentNetworkVersion: string;
  segments: Array<{ segmentId: string; bedElevationM: number; sections: Array<{ bedElevationM: number }> }>;
}

interface PolygonSetsFileShape {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: Array<{ segmentId: string; elevationBuckets: unknown[] }>;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export async function retainObservedWsePropagationInputs(): Promise<void> {
  const crossSectionsPath = path.join(EXTENT_OUTPUT, '01-cross-sections/cross-sections.json');
  const stage4Path = path.join(
    EXTENT_OUTPUT,
    `04-water-surface-polygons/${METHOD_ID}/v${METHOD_VERSION}/water-surface-polygon-sets/${COMID}.json`,
  );
  const crossSections = (await readJson(crossSectionsPath)) as CrossSectionsFileShape;
  const stage4Bytes = await readFile(stage4Path);
  const stage4 = JSON.parse(stage4Bytes.toString('utf8')) as PolygonSetsFileShape;
  for (const [label, version] of [
    ['Stage 1 cross-sections', crossSections.segmentNetworkVersion],
    ['Stage 4 polygon sets', stage4.segmentNetworkVersion],
  ] as const) {
    if (version !== SEGMENT_NETWORK_VERSION) throw new Error(`${label} segmentNetworkVersion is ${version}, expected ${SEGMENT_NETWORK_VERSION}.`);
  }

  // Stage 1's flow-direction rule: vertex order runs downstream when the first sampled bed is at or above the last.
  const sampledBeds = crossSections.segments.flatMap((record) => record.sections.map((section) => section.bedElevationM));
  const flowDirection = downstreamVertexDirection(sampledBeds);
  const bedElevationMBySegmentId: Record<string, number> = {};
  for (const record of crossSections.segments) bedElevationMBySegmentId[record.segmentId] = record.bedElevationM;
  const beds: CrossSectionBedsSnapshot = { segmentNetworkVersion: SEGMENT_NETWORK_VERSION, flowDirection, bedElevationMBySegmentId };

  const segments = segmentTncFlowline(await readJson(path.join(sourceInputsDirectory, FLOWLINE_SNAPSHOT_FILE)));
  const gaugeAssignment = (await readJson(path.join(sourceInputsDirectory, 'reviewed-assignments/monitoring-station-assignment-usgs-11120600.json'))) as {
    segmentId: string;
  };
  const nodes = propagationNodesById(segments, beds);
  const neighbours = propagatedSegmentsAround(gaugeAssignment.segmentId, nodes, OBSERVED_WSE_PROPAGATION.hopsPerDirection);
  if (neighbours.length === 0) throw new Error('The gauge segment has no neighbours to retain.');

  const polygonSetById = new Map(stage4.waterSurfacePolygonSets.map((polygonSet) => [polygonSet.segmentId, polygonSet]));
  const neighbourSets = neighbours.map((neighbour) => {
    const polygonSet = polygonSetById.get(neighbour.segmentId);
    if (!polygonSet) throw new Error(`Stage 4 output has no polygon set for ${neighbour.segmentId}.`);
    return polygonSet;
  });
  const snapshot = { segmentNetworkVersion: SEGMENT_NETWORK_VERSION, waterSurfacePolygonSets: neighbourSets };

  await writePrettyJson(path.join(sourceInputsDirectory, CROSS_SECTION_BEDS_SNAPSHOT_FILE), beds);
  const snapshotPath = path.join(sourceInputsDirectory, NEIGHBOUR_POLYGON_SET_SNAPSHOT_FILE);
  await writePrettyJson(snapshotPath, snapshot);
  const snapshotSha256 = sha256(await readFile(snapshotPath));
  const manifest = (await readJson(path.join(path.dirname(stage4Path), '..', 'manifest.json'))) as {
    completedAt?: string;
    parameters?: { wsePolygonGenerationMethod?: { codeSha256ByFile?: Record<string, string>; methodSha256?: string } };
  };
  await writePrettyJson(path.join(sourceInputsDirectory, NEIGHBOUR_POLYGON_SET_PROVENANCE_FILE), {
    file: NEIGHBOUR_POLYGON_SET_SNAPSHOT_FILE,
    fileSha256: snapshotSha256,
    description:
      `Reviewed snapshot of the modeled pipeline's Stage 4 prepared water-surface polygon sets for the Creek Segments within ` +
      `${OBSERVED_WSE_PROPAGATION.hopsPerDirection} segments upstream and downstream of the gauge's Creek Segment ${gaugeAssignment.segmentId} ` +
      `(observed WSE propagation, UCS-300). npm run pipeline:publish publishes them after the gauge segment's set, unchanged, ` +
      `so inferred water draws the same polygons modeled water does.`,
    segmentIds: neighbours.map((neighbour) => neighbour.segmentId),
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    wsePolygonGenerationMethod: { id: METHOD_ID, version: METHOD_VERSION, methodSha256: manifest.parameters?.wsePolygonGenerationMethod?.methodSha256 ?? null },
    source: {
      path: path.relative(repositoryRoot, stage4Path).split(path.sep).join('/'),
      sha256: sha256(stage4Bytes),
      stage4CompletedAt: manifest.completedAt ?? null,
      command: STAGE_4_COMMAND,
    },
    crossSectionBeds: {
      file: CROSS_SECTION_BEDS_SNAPSHOT_FILE,
      sourcePath: path.relative(repositoryRoot, crossSectionsPath).split(path.sep).join('/'),
      sourceSha256: sha256(await readFile(crossSectionsPath)),
      flowDirection,
    },
    extraction:
      'Kept segmentNetworkVersion and, in flow order from the gauge segment (upstream nearest first, then downstream nearest first), ' +
      'the waterSurfacePolygonSets entries of the listed segment ids, unchanged, then wrote them as two-space-indented JSON with a trailing newline.',
  });

  const gaugeSnapshot = (await readJson(path.join(sourceInputsDirectory, OBSERVED_POLYGON_SET_SNAPSHOT_FILE))) as PolygonSetsFileShape;
  const gaugeSet = gaugeSnapshot.waterSurfacePolygonSets[0];
  if (gaugeSet && JSON.stringify(gaugeSet) !== JSON.stringify(polygonSetById.get(gaugeAssignment.segmentId))) {
    console.warn(`The retained gauge snapshot differs from the current Stage 4 output for ${gaugeAssignment.segmentId}; refresh it by hand before publishing.`);
  }
  console.log(
    `Retained beds for ${crossSections.segments.length} Creek Segments (flow direction ${flowDirection}) and polygon sets for ${neighbours.length} neighbours: ` +
      `${neighbours.map((neighbour) => `${neighbour.segmentId} (${neighbour.direction} ${neighbour.hops})`).join(', ')}.`,
  );
}

const isCommandLineEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCommandLineEntryPoint) {
  try {
    await retainObservedWsePropagationInputs();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
