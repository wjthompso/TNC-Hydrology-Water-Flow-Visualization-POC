import path from 'node:path';
import { expectRecord, isRecord, readJson, writePrettyJson } from '../json-files.ts';
import { roundToDecimals, utm10nToWgs84, type UtmPoint } from '../utm-geometry.ts';
import { segmentMidpointUtm, type NetworkCreekSegment } from './creek-segment-network.ts';
import { exceedsMaximumTransferDistance, type NhdplusV2ReachAssignmentFile, type ReachAssignment } from './discharge-records.ts';
import { fetchJson, mapWithConcurrency, urlWithParams } from './http-download.ts';
import { distanceToReachM, loadReachGeometries } from './nhdplusv2-reach-geometry.ts';
import {
  DRAINAGE_AREA_RATIO_TRANSFER,
  EPA_NHDPLUSV2_FLOWLINE_QUERY,
  EXPECTED_GAUGE_REACH_NHDPLUSV2_COMID,
  MAXIMUM_TRANSFER_DISTANCE_M,
  MODELED_EXTENT,
  NHDPLUSV2_CROSSWALK_PATH,
  NHDPLUSV2_REACH_ATTRIBUTES_CACHE_FILE,
  NLDI_POSITION_CACHE_FILE,
  NLDI_POSITION_URL,
} from './pipeline-configuration.ts';

export const CROSSWALK_NOTE =
  'Two COMID numbering systems are in use. Creek Segment ids carry an NHD 1:24K COMID (27714637 is the Jalama TNC flowline). ' +
  'California Natural Flows and the NOAA National Water Model are keyed by NHDPlusV2 COMIDs (17593507 is the Jalama gauge reach). ' +
  'The same number never names the same line in both. REACHCODE 18060013000078 links the two for Jalama. ' +
  'Each Creek Segment midpoint was snapped to an NHDPlusV2 reach with the USGS NLDI (Network-Linked Data Index) position service.';

/** Parallel NLDI requests. The preserve has ~3,300 Creek Segments; 4 at a time took ~7 minutes. */
const NLDI_CONCURRENCY = 12;
/** The NLDI cache is saved after this many new lookups, so a rate-limit error loses at most this much progress. */
const NLDI_CACHE_SAVE_EVERY = 100;

const NLDI_METHOD =
  'USGS NLDI comid/position lookup at each Creek Segment midpoint (WGS84); a segment whose NLDI reach has a different ' +
  'REACHCODE than the TNC flowline is reassigned to the single NLDI-returned reach that shares the TNC flowline REACHCODE. ' +
  'reachDrainageAreaKm2 is the reach\'s NHDPlusV2 TotDASqKm from the EPA NHDPlus flowline service. ' +
  `${DRAINAGE_AREA_RATIO_TRANSFER.fieldName} (${DRAINAGE_AREA_RATIO_TRANSFER.label}) is true when no NLDI reach on the TNC flowline ` +
  "shares its REACHCODE, so the segment keeps the nearest reach of a different creek; transferDistanceM is the segment midpoint's " +
  `distance to that reach's flowline geometry, and a segment farther than ${MAXIMUM_TRANSFER_DISTANCE_M} m gets no discharge.`;

async function nldiComidAt(longitude: number, latitude: number): Promise<number | null> {
  const url = urlWithParams(NLDI_POSITION_URL, {
    coords: `POINT(${longitude.toFixed(7)} ${latitude.toFixed(7)})`,
  });
  const response = expectRecord(await fetchJson(url), 'NLDI position response');
  const features = Array.isArray(response.features) ? response.features : [];
  const first = features[0];
  if (!isRecord(first) || !isRecord(first.properties)) return null;
  const comid = Number(first.properties.comid ?? first.properties.identifier);
  return Number.isFinite(comid) ? comid : null;
}

/** The cached NLDI answer for one Creek Segment midpoint (EPSG 32610 meters). */
interface NldiPositionLookup {
  midpointX: number;
  midpointY: number;
  nhdplusV2Comid: number | null;
  /** Where the answer came from: the NLDI service, or the extent's tracked crosswalk (a reviewed earlier answer). */
  source: 'nldi' | 'reviewed-crosswalk';
}

interface NldiPositionCache {
  description: string;
  positionUrl: string;
  lookupsBySegmentId: Record<string, NldiPositionLookup>;
}

async function readNldiCache(cachePath: string): Promise<NldiPositionCache> {
  try {
    const record = expectRecord(await readJson(cachePath), cachePath);
    if (record.positionUrl === NLDI_POSITION_URL && isRecord(record.lookupsBySegmentId)) {
      return record as unknown as NldiPositionCache;
    }
  } catch {
    // No usable cache yet.
  }
  return {
    description:
      'USGS NLDI comid/position answer per Creek Segment midpoint, reused while the midpoint is unchanged. ' +
      'NLDI allows 3,600 requests per hour, so a rerun must not refetch every segment. ' +
      "An entry with source 'reviewed-crosswalk' was seeded from the extent's tracked crosswalk instead of fetched.",
    positionUrl: NLDI_POSITION_URL,
    lookupsBySegmentId: {},
  };
}

function sameMidpoint(cached: NldiPositionLookup | undefined, midpoint: UtmPoint): cached is NldiPositionLookup {
  return cached !== undefined && Math.abs(cached.midpointX - midpoint.x) < 0.01 && Math.abs(cached.midpointY - midpoint.y) < 0.01;
}

function nldiLookupAt(midpoint: UtmPoint, nhdplusV2Comid: number | null, source: NldiPositionLookup['source']): NldiPositionLookup {
  return { midpointX: roundToDecimals(midpoint.x, 3), midpointY: roundToDecimals(midpoint.y, 3), nhdplusV2Comid, source };
}

/**
 * Seed the NLDI cache from the extent's tracked crosswalk, which holds a reviewed NLDI answer for
 * every Creek Segment: `nldiComid` where the REACHCODE check reassigned the segment, otherwise
 * `nhdplusV2Comid`. Only a segment the cache lacks at its current midpoint is seeded, and only
 * when the crosswalk is for the same segment network. Returns how many entries were seeded.
 */
async function seedNldiCacheFromReviewedCrosswalk(cache: NldiPositionCache, segments: readonly NetworkCreekSegment[]): Promise<number> {
  let reviewed: Record<string, unknown>;
  try {
    reviewed = expectRecord(await readJson(NHDPLUSV2_CROSSWALK_PATH), NHDPLUSV2_CROSSWALK_PATH);
  } catch {
    return 0; // No tracked crosswalk for this extent yet.
  }
  if (reviewed.segmentNetworkVersion !== MODELED_EXTENT.segmentNetworkVersion || !Array.isArray(reviewed.segments)) return 0;
  const reviewedBySegmentId = new Map<string, Record<string, unknown>>();
  for (const entry of reviewed.segments) {
    if (isRecord(entry) && typeof entry.segmentId === 'string') reviewedBySegmentId.set(entry.segmentId, entry);
  }
  let seeded = 0;
  for (const segment of segments) {
    const midpoint = segmentMidpointUtm(segment);
    if (sameMidpoint(cache.lookupsBySegmentId[segment.segmentId], midpoint)) continue;
    const entry = reviewedBySegmentId.get(segment.segmentId);
    const nldiAnswer = entry?.nldiComid ?? entry?.nhdplusV2Comid;
    if (typeof nldiAnswer !== 'number') continue; // An unmapped segment is asked again.
    cache.lookupsBySegmentId[segment.segmentId] = nldiLookupAt(midpoint, nldiAnswer, 'reviewed-crosswalk');
    seeded += 1;
  }
  return seeded;
}

/**
 * NLDI reach per Creek Segment, in segment order. The cache in `cacheDirectory` is seeded from the
 * tracked crosswalk first, then only segments it still lacks are fetched. The cache is saved every
 * NLDI_CACHE_SAVE_EVERY lookups and again when fetching stops, so an error (such as NLDI's hourly
 * rate limit) keeps every answer received so far.
 */
async function lookupNldiComids(
  segments: readonly NetworkCreekSegment[],
  cacheDirectory: string,
): Promise<{ comids: (number | null)[]; fetched: number; reused: number; seeded: number }> {
  const cachePath = path.join(cacheDirectory, NLDI_POSITION_CACHE_FILE);
  const cache = await readNldiCache(cachePath);
  const seeded = await seedNldiCacheFromReviewedCrosswalk(cache, segments);
  if (seeded > 0) await writePrettyJson(cachePath, cache);
  const segmentsToFetch = segments.filter((segment) => !sameMidpoint(cache.lookupsBySegmentId[segment.segmentId], segmentMidpointUtm(segment)));
  const reused = segments.length - segmentsToFetch.length;
  console.log(`  NLDI: ${reused} cached answer(s), ${seeded} of them seeded from the tracked crosswalk; ${segmentsToFetch.length} lookup(s) to fetch.`);

  let fetched = 0;
  // Saves are chained so two never overlap on the same file.
  let lastSave = Promise.resolve();
  const saveCache = (): Promise<void> => {
    lastSave = lastSave.then(() => writePrettyJson(cachePath, cache));
    return lastSave;
  };
  try {
    await mapWithConcurrency(segmentsToFetch, NLDI_CONCURRENCY, async (segment) => {
      const midpoint = segmentMidpointUtm(segment);
      const [longitude, latitude] = utm10nToWgs84(midpoint.x, midpoint.y);
      const nhdplusV2Comid = await nldiComidAt(longitude, latitude);
      cache.lookupsBySegmentId[segment.segmentId] = nldiLookupAt(midpoint, nhdplusV2Comid, 'nldi');
      fetched += 1;
      if (fetched % NLDI_CACHE_SAVE_EVERY === 0) {
        console.log(`  NLDI lookups ${fetched} of ${segmentsToFetch.length} (cache saved)`);
        await saveCache();
      }
    });
  } finally {
    if (fetched > 0) await saveCache();
  }
  const comids = segments.map((segment) => cache.lookupsBySegmentId[segment.segmentId]?.nhdplusV2Comid ?? null);
  return { comids, fetched, reused, seeded };
}

interface NhdplusV2ReachAttributes {
  reachCode: string | null;
  gnisName: string;
  /** Total upstream drainage area at the reach outlet (NHDPlusV2 TotDASqKm), km². */
  totalDrainageAreaKm2: number | null;
}

interface ReachAttributeCache {
  description: string;
  source: string;
  attributesByComid: Record<string, NhdplusV2ReachAttributes>;
}

async function readReachAttributeCache(cachePath: string): Promise<ReachAttributeCache> {
  try {
    const record = expectRecord(await readJson(cachePath), cachePath);
    if (record.source === EPA_NHDPLUSV2_FLOWLINE_QUERY && isRecord(record.attributesByComid)) {
      return record as unknown as ReachAttributeCache;
    }
  } catch {
    // No usable cache yet.
  }
  return {
    description: 'REACHCODE, GNIS name, and TotDASqKm per NHDPlusV2 COMID from the EPA NHDPlus flowline service. Reused on reruns.',
    source: EPA_NHDPLUSV2_FLOWLINE_QUERY,
    attributesByComid: {},
  };
}

/** Attributes of every requested reach, reading the cache in `cacheDirectory` and fetching only the reaches it lacks. */
async function loadReachAttributes(
  nhdplusV2Comids: readonly number[],
  cacheDirectory: string,
): Promise<{ attributesByComid: Map<number, NhdplusV2ReachAttributes>; fetched: number; reused: number }> {
  const cachePath = path.join(cacheDirectory, NHDPLUSV2_REACH_ATTRIBUTES_CACHE_FILE);
  const cache = await readReachAttributeCache(cachePath);
  const attributesByComid = new Map<number, NhdplusV2ReachAttributes>();
  let fetched = 0;
  let reused = 0;
  try {
    await mapWithConcurrency(nhdplusV2Comids, 4, async (comid) => {
      const cached = cache.attributesByComid[String(comid)];
      if (cached !== undefined) {
        attributesByComid.set(comid, cached);
        reused += 1;
        return;
      }
      const attributes = await reachAttributesOf(comid);
      cache.attributesByComid[String(comid)] = attributes;
      attributesByComid.set(comid, attributes);
      fetched += 1;
    });
  } finally {
    if (fetched > 0) await writePrettyJson(cachePath, cache);
  }
  return { attributesByComid, fetched, reused };
}

async function reachAttributesOf(nhdplusV2Comid: number): Promise<NhdplusV2ReachAttributes> {
  const url = urlWithParams(EPA_NHDPLUSV2_FLOWLINE_QUERY, {
    where: `COMID=${nhdplusV2Comid}`,
    outFields: 'COMID,REACHCODE,GNIS_NAME,TOTDASQKM',
    returnGeometry: 'false',
    f: 'json',
  });
  const response = expectRecord(await fetchJson(url), 'EPA NHDPlusV2 flowline response');
  const features = Array.isArray(response.features) ? response.features : [];
  const first = features[0];
  if (!isRecord(first) || !isRecord(first.attributes)) return { reachCode: null, gnisName: '', totalDrainageAreaKm2: null };
  const reachCode = first.attributes.reachcode ?? first.attributes.REACHCODE;
  const gnisName = first.attributes.gnis_name ?? first.attributes.GNIS_NAME;
  const totalDrainageAreaKm2 = first.attributes.totdasqkm ?? first.attributes.TOTDASQKM;
  return {
    reachCode: typeof reachCode === 'string' ? reachCode : null,
    gnisName: typeof gnisName === 'string' ? gnisName.trim() : '',
    totalDrainageAreaKm2: typeof totalDrainageAreaKm2 === 'number' && totalDrainageAreaKm2 > 0 ? totalDrainageAreaKm2 : null,
  };
}

/** REACHCODE and GNIS (Geographic Names Information System) name of one TNC flowline. */
export interface TncFlowlineIdentity {
  reachCode: string;
  gnisName: string;
}

/**
 * Drainage-Area Ratio Transfer distance check. For every transfer segment, the distance from the
 * segment midpoint to the nearest point of the borrowed reach's flowline geometry. Stage 3 gives a
 * segment farther than the maximum no discharge; this only records the distance and warns.
 */
async function measureTransferDistances(input: {
  segments: readonly NetworkCreekSegment[];
  assignments: ReachAssignment[];
  cacheDirectory: string;
}): Promise<{ warnings: string[]; geometriesFetched: number; geometriesReused: number }> {
  const warnings: string[] = [];
  const transferAssignments = input.assignments.filter(
    (assignment) => assignment[DRAINAGE_AREA_RATIO_TRANSFER.fieldName] && assignment.nhdplusV2Comid !== null,
  );
  const geometries = await loadReachGeometries({
    nhdplusV2Comids: transferAssignments.map((assignment) => assignment.nhdplusV2Comid as number),
    cacheDirectory: input.cacheDirectory,
  });
  const segmentById = new Map(input.segments.map((segment) => [segment.segmentId, segment]));
  for (const assignment of transferAssignments) {
    const segment = segmentById.get(assignment.segmentId);
    const paths = geometries.pathsByComid.get(assignment.nhdplusV2Comid as number) ?? null;
    if (!segment || paths === null) {
      assignment.transferDistanceM = null;
      warnings.push(
        `Creek Segment ${assignment.segmentId}: no flowline geometry for borrowed NHDPlusV2 COMID ${String(assignment.nhdplusV2Comid)}; transfer distance unknown.`,
      );
      continue;
    }
    assignment.transferDistanceM = roundToDecimals(distanceToReachM(segmentMidpointUtm(segment), paths), 1);
    if (exceedsMaximumTransferDistance(assignment)) {
      warnings.push(
        `Creek Segment ${assignment.segmentId}: borrowed NHDPlusV2 COMID ${String(assignment.nhdplusV2Comid)} is ${assignment.transferDistanceM} m away, ` +
          `more than ${MAXIMUM_TRANSFER_DISTANCE_M} m; it gets no discharge.`,
      );
    }
  }
  return { warnings, geometriesFetched: geometries.fetched, geometriesReused: geometries.reused };
}

/**
 * Snap each Creek Segment midpoint to an NHDPlusV2 reach with NLDI, then check it against
 * the segment's own TNC flowline. REACHCODE links the two COMID numbering systems. NLDI snaps
 * by catchment, so a point near a confluence can land in a tributary's catchment; such a
 * segment is moved to the single NLDI reach on the same flowline that shares its REACHCODE.
 * A flowline with no matching reach at all keeps the NLDI reach of a neighbouring creek and
 * is marked as a Drainage-Area Ratio Transfer, with its distance to that reach measured.
 * A named flowline whose reach carries a different GNIS name also gets a warning.
 */
export async function buildNhdplusV2ReachCrosswalk(input: {
  segments: readonly NetworkCreekSegment[];
  flowlineIdentityByComid: ReadonlyMap<number, TncFlowlineIdentity>;
  /** Where the reach geometry cache lives (the Stage 0 output directory). */
  cacheDirectory: string;
}): Promise<{
  assignments: NhdplusV2ReachAssignmentFile;
  warnings: string[];
  reachGeometriesFetched: number;
  reachGeometriesReused: number;
  reachAttributesFetched: number;
  reachAttributesReused: number;
  nldiLookupsFetched: number;
  nldiLookupsReused: number;
  nldiLookupsSeeded: number;
}> {
  const warnings: string[] = [];
  const nldi = await lookupNldiComids(input.segments, input.cacheDirectory);
  const { comids } = nldi;
  const nldiDistinct = [...new Set(comids.flatMap((comid) => (comid === null ? [] : [comid])))];
  const attributes = await loadReachAttributes(nldiDistinct, input.cacheDirectory);
  const reachAttributes = attributes.attributesByComid;
  const reachCodes: Record<string, string | null> = {};
  for (const comid of [...nldiDistinct].sort((a, b) => a - b)) reachCodes[String(comid)] = reachAttributes.get(comid)?.reachCode ?? null;

  // The single NLDI reach per TNC flowline whose REACHCODE matches that flowline's REACHCODE.
  const matchingReachByFlowline = new Map<number, number | undefined>();
  for (const flowlineComid of new Set(input.segments.map((segment) => segment.comid))) {
    const flowlineReachCode = input.flowlineIdentityByComid.get(flowlineComid)?.reachCode;
    const candidates = new Set(
      input.segments.flatMap((segment, index) => (segment.comid === flowlineComid && comids[index] != null ? [comids[index] as number] : [])),
    );
    const matches = [...candidates].filter((comid) => reachCodes[String(comid)] === flowlineReachCode);
    matchingReachByFlowline.set(flowlineComid, matches.length === 1 ? matches[0] : undefined);
  }

  const reachesWithoutDrainageArea = new Set<number>();
  const reachDrainageAreaOf = (assignedComid: number): number | null => {
    const areaKm2 = reachAttributes.get(assignedComid)?.totalDrainageAreaKm2 ?? null;
    if (areaKm2 === null) reachesWithoutDrainageArea.add(assignedComid);
    return areaKm2;
  };
  const segments: ReachAssignment[] = input.segments.map((segment, index) => {
    const nldiComid = comids[index] ?? null;
    if (nldiComid === null) {
      warnings.push(`Creek Segment ${segment.segmentId} has no NHDPlusV2 reach (unmapped).`);
      return {
        segmentId: segment.segmentId,
        nhdplusV2Comid: null,
        reachDrainageAreaKm2: null,
        [DRAINAGE_AREA_RATIO_TRANSFER.fieldName]: false,
      };
    }
    const flowline = input.flowlineIdentityByComid.get(segment.comid);
    const flowlineReachCode = flowline?.reachCode ?? '';
    const reachCode = reachCodes[String(nldiComid)];
    const reachCodeComid = matchingReachByFlowline.get(segment.comid);
    const checkGnisName = (assignedComid: number): void => {
      const reachName = reachAttributes.get(assignedComid)?.gnisName ?? '';
      if (flowline?.gnisName && reachName && reachName !== flowline.gnisName) {
        warnings.push(
          `Creek Segment ${segment.segmentId}: NHDPlusV2 COMID ${assignedComid} is named "${reachName}", but TNC flowline ${segment.comid} is "${flowline.gnisName}".`,
        );
      }
    };
    if (reachCode === flowlineReachCode || reachCodeComid === undefined) {
      // No reach on this flowline shares its REACHCODE: the creek has no NHDPlusV2 reach of its own,
      // so the segment borrows the nearest reach of a different creek (Drainage-Area Ratio Transfer).
      const isTransfer = reachCode !== flowlineReachCode;
      if (isTransfer) {
        warnings.push(
          `Creek Segment ${segment.segmentId}: NHDPlusV2 COMID ${nldiComid} has REACHCODE ${String(reachCode)}, not ${flowlineReachCode}; ` +
            `kept because no single matching reach exists (${DRAINAGE_AREA_RATIO_TRANSFER.label}).`,
        );
      }
      checkGnisName(nldiComid);
      return {
        segmentId: segment.segmentId,
        nhdplusV2Comid: nldiComid,
        reachDrainageAreaKm2: reachDrainageAreaOf(nldiComid),
        [DRAINAGE_AREA_RATIO_TRANSFER.fieldName]: isTransfer,
      };
    }
    warnings.push(
      `Creek Segment ${segment.segmentId}: NLDI returned NHDPlusV2 COMID ${nldiComid} (REACHCODE ${String(reachCode)}); reassigned to ${reachCodeComid} (REACHCODE ${flowlineReachCode}).`,
    );
    checkGnisName(reachCodeComid);
    return {
      segmentId: segment.segmentId,
      nhdplusV2Comid: reachCodeComid,
      reachDrainageAreaKm2: reachDrainageAreaOf(reachCodeComid),
      [DRAINAGE_AREA_RATIO_TRANSFER.fieldName]: false,
      nldiComid,
      reassignedReason: `NLDI reach REACHCODE ${String(reachCode)} differs from TNC flowline REACHCODE ${flowlineReachCode}`,
    };
  });

  const transferDistances = await measureTransferDistances({ segments: input.segments, assignments: segments, cacheDirectory: input.cacheDirectory });
  warnings.push(...transferDistances.warnings);

  for (const comid of [...reachesWithoutDrainageArea].sort((a, b) => a - b)) {
    warnings.push(`NHDPlusV2 COMID ${comid} has no TotDASqKm; its Creek Segments keep the whole reach discharge (ratio 1).`);
  }
  const distinct = [...new Set(segments.flatMap((entry) => (entry.nhdplusV2Comid === null ? [] : [entry.nhdplusV2Comid])))];
  if (!distinct.includes(EXPECTED_GAUGE_REACH_NHDPLUSV2_COMID)) {
    warnings.push(`No Creek Segment mapped to the expected gauge reach NHDPlusV2 COMID ${EXPECTED_GAUGE_REACH_NHDPLUSV2_COMID}.`);
  }

  return {
    assignments: {
      note: CROSSWALK_NOTE,
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      method: NLDI_METHOD,
      segments,
      reachCodes,
    },
    warnings,
    reachGeometriesFetched: transferDistances.geometriesFetched,
    reachGeometriesReused: transferDistances.geometriesReused,
    reachAttributesFetched: attributes.fetched,
    reachAttributesReused: attributes.reused,
    nldiLookupsFetched: nldi.fetched,
    nldiLookupsReused: nldi.reused,
    nldiLookupsSeeded: nldi.seeded,
  };
}
