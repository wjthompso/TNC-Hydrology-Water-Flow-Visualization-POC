import { crossSectionOffsetsM, type RunChannel } from '../../modeled-wse-derivation-methods/m3-flowline-profile-manning-depth/flowline-channel.ts';
import { fillGaps, gaussianSmooth, medianFilter } from '../../modeled-wse-derivation-methods/m3-flowline-profile-manning-depth/series-smoothing.ts';
import { FLOWLINE_CHANNEL_RIBBON_METHOD } from './method-config.ts';

/**
 * Edges of the channel ribbon at every table station of one run and every depth rung: how far left and right of the smoothed
 * centerline the water reaches when it stands `rung` meters above the station's bed. See DESIGN.md.
 *
 * Per station and rung the edges come from ONE cross-section (a 1-D flood of the lateral lidar profile), not from a 2-D flood of
 * the raster. The raw edges are then smoothed ALONG the creek (median, then Gaussian), kept monotone with depth, widened to the
 * display floor, and kept from crossing on the inside of bends. The result is a smooth function of position and depth that always
 * covers the station's lowest point, where the water's bed was measured, so thin water is never drawn beside the creek on its bank.
 */

const PARAMETERS = FLOWLINE_CHANNEL_RIBBON_METHOD.parameters;

export interface RibbonEdges {
  rungDepthsM: readonly number[];
  /** left[rung][station] is the left edge (offset m, positive left of flow); right[rung][station] ≤ left is the right edge. Display edges (floors applied). */
  left: Float32Array[];
  right: Float32Array[];
  /** True top width (left − right of the lidar flood before any floor, smoothed like the display edges), m; 0 where the lidar flood is dry at the centerline. */
  trueTopWidthM: Float32Array[];
}

/** First crossing of `level` walking outward from `seedIndex`; the offset where the ground meets the level (linear between samples). */
function edgeOffset(offsets: readonly number[], ground: readonly number[], seedIndex: number, step: 1 | -1, level: number): number {
  let index = seedIndex;
  for (;;) {
    const next = index + step;
    if (next < 0 || next >= offsets.length) return offsets[index] as number;
    const nextGround = ground[next] as number;
    if (Number.isNaN(nextGround)) return offsets[index] as number;
    if (nextGround >= level) {
      const here = ground[index] as number;
      const fraction = nextGround === here ? 0 : (level - here) / (nextGround - here);
      return (offsets[index] as number) + Math.max(0, Math.min(1, fraction)) * ((offsets[next] as number) - (offsets[index] as number));
    }
    index = next;
  }
}

export function computeRibbonEdges(channel: RunChannel): RibbonEdges {
  const rungs = PARAMETERS.rungDepthsM;
  const offsets = crossSectionOffsetsM();
  const count = channel.stationCount;
  const rawLeft = rungs.map(() => new Float64Array(count).fill(Number.NaN));
  const rawRight = rungs.map(() => new Float64Array(count).fill(Number.NaN));
  for (let station = 0; station < count; station += 1) {
    const ground = offsets.map((offset) => channel.groundAt(station, offset) ?? Number.NaN);
    // Seeded at the station's lowest point, where its bed was measured, so a rung depth means the same water here as in the rating curve.
    const thalwegOffsetM = channel.thalwegOffsetM[station] as number;
    let seed = -1;
    offsets.forEach((offset, index) => {
      if (seed < 0 || Math.abs(offset - thalwegOffsetM) < Math.abs((offsets[seed] as number) - thalwegOffsetM)) seed = index;
    });
    const seedGround = ground[seed] as number;
    if (Number.isNaN(seedGround)) continue;
    rungs.forEach((depth, rung) => {
      const level = (channel.bedM[station] as number) + depth;
      // Dry at the lowest point for the lidar (always on a breached barrier, whose bed is below the fill): filled in from the neighbours below.
      if (seedGround >= level) return;
      (rawLeft[rung] as Float64Array)[station] = edgeOffset(offsets, ground, seed, 1, level);
      (rawRight[rung] as Float64Array)[station] = edgeOffset(offsets, ground, seed, -1, level);
    });
  }

  const sigmaPoints = PARAMETERS.edgeSmoothing.gaussianSigmaM / channel.spacingM;
  const medianPoints = Math.round(PARAMETERS.edgeSmoothing.medianWindowM / channel.spacingM);
  const smoothEdge = (values: Float64Array, fallback: number): Float64Array => {
    const copy = Float64Array.from(values);
    if (!fillGaps(copy)) return new Float64Array(count).fill(fallback);
    return gaussianSmooth(medianFilter(copy, medianPoints), sigmaPoints);
  };
  const left = rungs.map(() => new Float32Array(count));
  const right = rungs.map(() => new Float32Array(count));
  const trueTopWidthM = rungs.map(() => new Float32Array(count));
  const minHalf = PARAMETERS.minimumTopWidthM / 2;
  const insideMarginM = PARAMETERS.thalwegInsideMarginM;
  const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
  const curvatureLimit = (station: number, side: 1 | -1): number => {
    // Turning left (positive curvature) makes the left side the inside of the bend: an edge farther out than the radius would cross itself.
    const turn = (channel.curvature[station] as number) * side;
    return turn > 1e-6 ? PARAMETERS.innerBendRadiusFraction / turn : Infinity;
  };
  const finalSigmaPoints = PARAMETERS.edgeSmoothing.finalGaussianSigmaM / channel.spacingM;
  rungs.forEach((depthM, rung) => {
    const smoothLeft = smoothEdge(rawLeft[rung] as Float64Array, 0);
    const smoothRight = smoothEdge(rawRight[rung] as Float64Array, 0);
    const flooredLeft = new Float64Array(count);
    const flooredRight = new Float64Array(count);
    for (let station = 0; station < count; station += 1) {
      let leftEdge = smoothLeft[station] as number;
      let rightEdge = smoothRight[station] as number;
      if (rightEdge > leftEdge) [leftEdge, rightEdge] = [rightEdge, leftEdge];
      const thalwegOffsetM = channel.thalwegOffsetM[station] as number;
      // A film of water a few centimeters deep does not spread over a flat valley floor: cap the top width by the depth, on the lowest point as far as the flood allows.
      const widthCapM = PARAMETERS.maximumTopWidth.baseM + PARAMETERS.maximumTopWidth.perMeterOfDepthM * depthM;
      if (leftEdge - rightEdge > widthCapM) {
        const middle = clamp(thalwegOffsetM, rightEdge + widthCapM / 2, leftEdge - widthCapM / 2);
        leftEdge = middle + widthCapM / 2;
        rightEdge = middle - widthCapM / 2;
      }
      (trueTopWidthM[rung] as Float32Array)[station] = leftEdge - rightEdge;
      if (leftEdge - rightEdge < PARAMETERS.minimumTopWidthM) {
        const middle = clamp((leftEdge + rightEdge) / 2, thalwegOffsetM - minHalf + insideMarginM, thalwegOffsetM + minHalf - insideMarginM);
        leftEdge = middle + minHalf;
        rightEdge = middle - minHalf;
      }
      flooredLeft[station] = leftEdge;
      flooredRight[station] = rightEdge;
    }
    // Widening thin water to the floor re-centres it on a midpoint that can jump across the centerline; one more pass smooths that out.
    const finalLeft = gaussianSmooth(flooredLeft, finalSigmaPoints);
    const finalRight = gaussianSmooth(flooredRight, finalSigmaPoints);
    for (let station = 0; station < count; station += 1) {
      // The smoothing may pull an edge back over the lowest point where it jostles; widen that side so the water covers it.
      const thalwegOffsetM = channel.thalwegOffsetM[station] as number;
      let leftEdge = Math.max(finalLeft[station] as number, thalwegOffsetM + insideMarginM);
      let rightEdge = Math.min(finalRight[station] as number, thalwegOffsetM - insideMarginM);
      // Monotone with depth: a deeper rung is never narrower than the one below.
      if (rung > 0) {
        leftEdge = Math.max(leftEdge, (left[rung - 1] as Float32Array)[station] as number);
        rightEdge = Math.min(rightEdge, (right[rung - 1] as Float32Array)[station] as number);
      }
      (left[rung] as Float32Array)[station] = leftEdge;
      (right[rung] as Float32Array)[station] = rightEdge;
    }
  });
  // The inside-of-bend cap is the same at every depth, so applying it after the monotone pass keeps the rungs monotone.
  for (let station = 0; station < count; station += 1) {
    const leftLimit = Math.max(minHalf, curvatureLimit(station, 1));
    const rightLimit = -Math.max(minHalf, curvatureLimit(station, -1));
    rungs.forEach((_depth, rung) => {
      let leftEdge = Math.min((left[rung] as Float32Array)[station] as number, leftLimit);
      let rightEdge = Math.max((right[rung] as Float32Array)[station] as number, rightLimit);
      // Water lying wholly past the other side's limit would come out with its edges crossed; keep the floor width inside the limits instead.
      if (leftEdge - rightEdge < PARAMETERS.minimumTopWidthM) {
        const middle = Math.min(leftLimit - minHalf, Math.max(rightLimit + minHalf, (leftEdge + rightEdge) / 2));
        leftEdge = middle + minHalf;
        rightEdge = middle - minHalf;
      }
      (left[rung] as Float32Array)[station] = leftEdge;
      (right[rung] as Float32Array)[station] = rightEdge;
    });
  }
  return { rungDepthsM: rungs, left, right, trueTopWidthM };
}
