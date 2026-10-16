/**
 * Hydraulic geometry of one cross-section profile at one water-surface elevation (WSE).
 * The wetted region is the run of ground below the WSE that contains the thalweg sample;
 * it ends at the first sample on each side at or above the WSE (the bank), interpolated linearly.
 */

export interface ProfileSample {
  /** Signed distance from the TNC flowline, meters; negative = left looking downstream. */
  offsetM: number;
  elevationM: number;
}

export interface WettedGeometry {
  areaM2: number;
  wettedPerimeterM: number;
  topWidthM: number;
  /** True when water reaches the end of the profile on either side, so A and P are underestimates. */
  spillsPastProfileEnd: boolean;
}

function crossingOffset(below: ProfileSample, above: ProfileSample, wse: number): number {
  const rise = above.elevationM - below.elevationM;
  if (rise === 0) return below.offsetM;
  return below.offsetM + ((wse - below.elevationM) / rise) * (above.offsetM - below.offsetM);
}

export function wettedGeometryAt(profile: readonly ProfileSample[], thalwegIndex: number, wse: number): WettedGeometry {
  const thalweg = profile[thalwegIndex];
  if (!thalweg || thalweg.elevationM >= wse) {
    return { areaM2: 0, wettedPerimeterM: 0, topWidthM: 0, spillsPastProfileEnd: false };
  }
  let left = thalwegIndex;
  while (left > 0 && (profile[left - 1]?.elevationM ?? Infinity) < wse) left -= 1;
  let right = thalwegIndex;
  while (right < profile.length - 1 && (profile[right + 1]?.elevationM ?? Infinity) < wse) right += 1;

  // Build the wetted polyline: bank crossing, submerged samples, bank crossing.
  const polyline: ProfileSample[] = [];
  const leftOuter = profile[left - 1];
  const leftInner = profile[left] as ProfileSample;
  polyline.push(leftOuter ? { offsetM: crossingOffset(leftInner, leftOuter, wse), elevationM: wse } : leftInner);
  for (let index = left; index <= right; index += 1) polyline.push(profile[index] as ProfileSample);
  const rightOuter = profile[right + 1];
  const rightInner = profile[right] as ProfileSample;
  polyline.push(rightOuter ? { offsetM: crossingOffset(rightInner, rightOuter, wse), elevationM: wse } : rightInner);

  let areaM2 = 0;
  let wettedPerimeterM = 0;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1] as ProfileSample;
    const b = polyline[index] as ProfileSample;
    const width = b.offsetM - a.offsetM;
    areaM2 += (width * ((wse - a.elevationM) + (wse - b.elevationM))) / 2;
    wettedPerimeterM += Math.hypot(width, b.elevationM - a.elevationM);
  }
  const first = polyline[0] as ProfileSample;
  const last = polyline[polyline.length - 1] as ProfileSample;
  return {
    areaM2,
    wettedPerimeterM,
    topWidthM: last.offsetM - first.offsetM,
    spillsPastProfileEnd: !leftOuter || !rightOuter,
  };
}

/**
 * Bank tops of one (valley-edge-trimmed) profile. On each side, the bank top is the highest ground
 * between the thalweg and `searchHalfWidthM` from the TNC flowline (the sample nearest the thalweg
 * on a tie). These are the same points the former ±60 m section found as "highest ground from the
 * thalweg outward"; the lower of the two is where water first leaves the main channel. Between the
 * two bank tops is the main channel; outside them, up to the valley edges, is floodplain.
 */
export function bankTopIndices(
  profile: readonly ProfileSample[],
  thalwegIndex: number,
  searchHalfWidthM: number,
): { leftIndex: number; rightIndex: number } {
  const elevationAt = (index: number): number => profile[index]?.elevationM ?? -Infinity;
  let leftIndex = thalwegIndex;
  for (let index = thalwegIndex; index >= 0 && Math.abs(profile[index]?.offsetM ?? Infinity) <= searchHalfWidthM; index -= 1) {
    if (elevationAt(index) > elevationAt(leftIndex)) leftIndex = index;
  }
  let rightIndex = thalwegIndex;
  for (
    let index = thalwegIndex;
    index < profile.length && Math.abs(profile[index]?.offsetM ?? Infinity) <= searchHalfWidthM;
    index += 1
  ) {
    if (elevationAt(index) > elevationAt(rightIndex)) rightIndex = index;
  }
  return { leftIndex, rightIndex };
}

/**
 * Valley-edge guard. On each side of the thalweg, the index of the highest sample between the
 * thalweg and that end of the profile (the one nearest the thalweg on a tie). Trimming the
 * profile to these two indices keeps the section inside its own valley: past a valley edge the
 * ground falls toward a neighbouring valley, and water there would not belong to this creek.
 */
export function valleyEdgeIndices(
  profile: readonly ProfileSample[],
  thalwegIndex: number,
): { leftIndex: number; rightIndex: number } {
  let leftIndex = thalwegIndex;
  for (let index = thalwegIndex; index >= 0; index -= 1) {
    if ((profile[index]?.elevationM ?? -Infinity) > (profile[leftIndex]?.elevationM ?? -Infinity)) leftIndex = index;
  }
  let rightIndex = thalwegIndex;
  for (let index = thalwegIndex; index < profile.length; index += 1) {
    if ((profile[index]?.elevationM ?? -Infinity) > (profile[rightIndex]?.elevationM ?? -Infinity)) rightIndex = index;
  }
  return { leftIndex, rightIndex };
}
