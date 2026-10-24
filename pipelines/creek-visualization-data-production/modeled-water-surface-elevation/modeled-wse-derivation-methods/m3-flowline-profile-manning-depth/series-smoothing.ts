/**
 * Small, deterministic 1-D filters over evenly spaced series, used by the m3 channel (centerline, bed profile)
 * and by the `flowline-channel-ribbon` outline smoothing. Plain loops, no dependencies.
 */

/** Gaussian kernel weights out to 3 standard deviations; `sigmaPoints` is in samples. */
function gaussianKernel(sigmaPoints: number): number[] {
  const radius = Math.max(1, Math.ceil(3 * sigmaPoints));
  const weights: number[] = [];
  for (let offset = -radius; offset <= radius; offset += 1) weights.push(Math.exp(-(offset * offset) / (2 * sigmaPoints * sigmaPoints)));
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return weights.map((weight) => weight / sum);
}

/**
 * Gaussian smoothing with odd reflection at both ends: a value past the end is 2 × (end value) − (the value as far inside),
 * so the end values stay where they are and a straight trend is not bent. Series shorter than 2 are returned as they are.
 */
export function gaussianSmooth(values: ArrayLike<number>, sigmaPoints: number): Float64Array {
  const count = values.length;
  const smoothed = new Float64Array(count);
  if (count < 2 || sigmaPoints <= 0) {
    for (let index = 0; index < count; index += 1) smoothed[index] = values[index] as number;
    return smoothed;
  }
  const kernel = gaussianKernel(sigmaPoints);
  const radius = (kernel.length - 1) / 2;
  const at = (index: number): number => {
    if (index < 0) return 2 * (values[0] as number) - (values[Math.min(count - 1, -index)] as number);
    if (index >= count) return 2 * (values[count - 1] as number) - (values[Math.max(0, 2 * (count - 1) - index)] as number);
    return values[index] as number;
  };
  for (let index = 0; index < count; index += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) sum += (kernel[offset + radius] as number) * at(index + offset);
    smoothed[index] = sum;
  }
  return smoothed;
}

/** Median over a window of `windowPoints` samples (odd after rounding) that shrinks toward each end so the end values stay. */
export function medianFilter(values: ArrayLike<number>, windowPoints: number): Float64Array {
  const count = values.length;
  const half = Math.floor(windowPoints / 2);
  const filtered = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const reach = Math.min(half, index, count - 1 - index);
    const window: number[] = [];
    for (let position = index - reach; position <= index + reach; position += 1) window.push(values[position] as number);
    window.sort((a, b) => a - b);
    filtered[index] = window[Math.floor(window.length / 2)] as number;
  }
  return filtered;
}

/**
 * Pool-adjacent-violators isotonic regression: the closest series (least squares) that never falls from one sample to
 * the next. `nonIncreasing` flips it to a series that never rises.
 */
export function isotonicRegression(values: ArrayLike<number>, nonIncreasing: boolean): Float64Array {
  const count = values.length;
  const sign = nonIncreasing ? -1 : 1;
  const blockMeans: number[] = [];
  const blockSizes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    blockMeans.push(sign * (values[index] as number));
    blockSizes.push(1);
    while (blockMeans.length > 1 && (blockMeans[blockMeans.length - 2] as number) > (blockMeans[blockMeans.length - 1] as number)) {
      const lastMean = blockMeans.pop() as number;
      const lastSize = blockSizes.pop() as number;
      const previousSize = blockSizes[blockSizes.length - 1] as number;
      const previousMean = blockMeans[blockMeans.length - 1] as number;
      blockMeans[blockMeans.length - 1] = (previousMean * previousSize + lastMean * lastSize) / (previousSize + lastSize);
      blockSizes[blockSizes.length - 1] = previousSize + lastSize;
    }
  }
  const result = new Float64Array(count);
  let index = 0;
  blockMeans.forEach((mean, block) => {
    for (let member = 0; member < (blockSizes[block] as number); member += 1) result[index++] = sign * mean;
  });
  return result;
}

/** Fills NaN entries by linear interpolation between the nearest finite neighbours; leading and trailing NaNs take the nearest finite value. Returns false when nothing is finite. */
export function fillGaps(values: Float64Array): boolean {
  const count = values.length;
  let previous = -1;
  for (let index = 0; index < count; index += 1) {
    if (Number.isNaN(values[index])) continue;
    if (previous === -1) for (let gap = 0; gap < index; gap += 1) values[gap] = values[index] as number;
    else if (index - previous > 1) {
      for (let gap = previous + 1; gap < index; gap += 1) {
        const fraction = (gap - previous) / (index - previous);
        values[gap] = (values[previous] as number) + fraction * ((values[index] as number) - (values[previous] as number));
      }
    }
    previous = index;
  }
  if (previous === -1) return false;
  for (let gap = previous + 1; gap < count; gap += 1) values[gap] = values[previous] as number;
  return true;
}
