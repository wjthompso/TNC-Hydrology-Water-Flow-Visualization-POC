import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { readJson } from '../json-files.ts';
import { junctionNeighboursById, loadCreekSegmentNetwork } from '../modeled-water-surface-elevation/creek-segment-network.ts';
import { MODELED_EXTENT, stageDirectory } from '../modeled-water-surface-elevation/pipeline-configuration.ts';
import {
  CROSS_SECTIONS_FILE,
  downstreamVertexDirectionByTncComid,
  tncComidOfSegmentId,
  type CrossSectionsFile,
} from '../modeled-water-surface-elevation/stage-file-formats.ts';

/**
 * Writes the Creek Segment network of one extent as plain JSON for the Python ArcGIS publishing
 * scripts, so they never reimplement segmentation. Uses the same code Stage 3 uses: TNC flowline
 * segmentation, junction neighbours, and Stage 1's flow-direction rule.
 *
 *   node --experimental-strip-types export-creek-segment-network.ts --extent=dangermond-preserve --output=<file>
 */

const outputFlag = process.argv.find((argument) => argument.startsWith('--output='));
if (!outputFlag) throw new Error('Pass --output=<path to the creek-segment-network.json to write>.');
const outputPath = path.resolve(outputFlag.slice('--output='.length));

const crossSections = (await readJson(path.join(stageDirectory('crossSections'), CROSS_SECTIONS_FILE))) as CrossSectionsFile;
const flowDirectionByTncComid = downstreamVertexDirectionByTncComid(crossSections);
const segments = await loadCreekSegmentNetwork();
const neighboursById = junctionNeighboursById(segments, flowDirectionByTncComid);

const exportedSegments = segments.map((segment) => {
  const tncComid = tncComidOfSegmentId(segment.segmentId);
  const flowDirection = flowDirectionByTncComid.get(tncComid) ?? 1;
  const neighbours = neighboursById.get(segment.segmentId);
  return {
    segmentId: segment.segmentId,
    tncComid,
    vertexIndexStart: segment.vertexIndexStart,
    vertexIndexEnd: segment.vertexIndexEnd,
    lengthM: segment.lengthM,
    pathWgs84: segment.pathWgs84,
    flowDirection,
    upstreamVertexIndex: flowDirection === 1 ? segment.vertexIndexStart : segment.vertexIndexEnd,
    downstreamVertexIndex: flowDirection === 1 ? segment.vertexIndexEnd : segment.vertexIndexStart,
    upstreamSegmentId: neighbours?.upstreamSegmentId ?? null,
    downstreamSegmentId: neighbours?.downstreamSegmentId ?? null,
  };
});

await writeFile(
  outputPath,
  `${JSON.stringify({
    description:
      'Creek Segment network exported from creek-segment-network.ts for ArcGIS publishing. flowDirection is +1 when a higher vertex index is farther downstream on the TNC flowline, -1 otherwise (Stage 1 rule).',
    extentId: MODELED_EXTENT.extentId,
    segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
    segments: exportedSegments,
  })}\n`,
);
process.stdout.write(`Exported ${exportedSegments.length} Creek Segments to ${outputPath}\n`);
