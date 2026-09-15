/**
 * Fetches Dangermond Preserve NHD 1:24k flowlines, samples USGS 3DEP
 * valley-bottom elevation on each reach, and writes public/data/reach.json.
 *
 * Native layer CRS is WKID 102645 / 2229 (NAD 1983 StatePlane CA V, US feet).
 * Always query with outSR=4326 and f=geojson — default JSON geometry is feet.
 * Vertex Z is 0 even with returnZ; do not treat it as NAVD88. Use 3DEP instead.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '../public/data/reach.json');
const CENTERLINE_URL =
  'https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_nhd24kflowlines_streams/FeatureServer/7/query';
const USGS_ELEVATION_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

const MAX_STAGE_FT = 3;
const FT_TO_M = 0.3048;

const STAGES = Array.from({ length: MAX_STAGE_FT / 0.25 + 1 }, (_, i) => {
  const ft = i * 0.25;
  const id =
    ft === 0
      ? 'baseline'
      : `plus-${String(ft).replace('.', '-')}ft`;
  return {
    id,
    label: ft === 0 ? 'Baseline (0 ft)' : `+${ft} ft`,
    offsetM: FT_TO_M * ft,
  };
});

/** Off unless debugging a single short slice. */
const TRIM_REACH_M = 0;
const SAMPLE_SPACING_M = 12;
/** Keep in sync with src/water-stage.ts — 20 m full width at stage 0. */
const BASE_HALF_WIDTH_M = 10;
const WIDTH_GROWTH_PER_M_STAGE = 1.8;
const PROBE_DISTANCES_M = [0];
for (const d of [4, 8, 12, 16, 20, 24]) {
  PROBE_DISTANCES_M.push(d, -d);
}
const GET_SAMPLES_BATCH = 100;
const USGS_CONCURRENCY = 4;
const CONNECTOR_FCODE = 33400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lonLatToLocalM(lon, lat, originLon, originLat) {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    x: (lon - originLon) * mPerDegLon,
    y: (lat - originLat) * mPerDegLat,
  };
}

function resampleLine(points, spacingM) {
  if (points.length < 2) return points;

  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }

  const total = cum[cum.length - 1];
  const count = Math.max(2, Math.floor(total / spacingM) + 1);
  const out = [];

  for (let s = 0; s < count; s++) {
    const dist = (s / (count - 1)) * total;
    let idx = cum.findIndex((d) => d >= dist);
    if (idx <= 0) idx = 1;
    const d0 = cum[idx - 1];
    const d1 = cum[idx];
    const t = d1 === d0 ? 0 : (dist - d0) / (d1 - d0);
    const p0 = points[idx - 1];
    const p1 = points[idx];
    out.push({
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
      chainageM: dist,
    });
  }

  return out;
}

function trimReach(points, maxLenM) {
  const out = [points[0]];
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - out[out.length - 1].x;
    const dy = points[i].y - out[out.length - 1].y;
    len += Math.hypot(dx, dy);
    if (len > maxLenM) break;
    out.push({ ...points[i], chainageM: len });
  }
  return out;
}

function perpendicularUnitNormal(centerline, index) {
  const pt = centerline[index];
  const prev = centerline[Math.max(0, index - 1)];
  const next = centerline[Math.min(centerline.length - 1, index + 1)];
  const metersPerLon = 111320 * Math.cos((pt.lat * Math.PI) / 180);
  const dx = (next.lon - prev.lon) * metersPerLon;
  const dy = (next.lat - prev.lat) * 111320;
  const len = Math.hypot(dx, dy) || 1;
  return {
    nx: -dy / len,
    ny: dx / len,
    metersPerLon,
  };
}

function offsetLonLat(lon, lat, nx, ny, metersPerLon, distanceM) {
  return {
    lon: lon + (nx * distanceM) / metersPerLon,
    lat: lat + (ny * distanceM) / 111320,
  };
}

function crossSectionProbePoints(centerline, index) {
  const pt = centerline[index];
  const { nx, ny, metersPerLon } = perpendicularUnitNormal(centerline, index);
  return PROBE_DISTANCES_M.map((distanceM) => ({
    ...offsetLonLat(pt.lon, pt.lat, nx, ny, metersPerLon, distanceM),
    centerlineIndex: index,
    offsetM: distanceM,
  }));
}

function lineParts(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function displayReachName(gnisName) {
  const name = (gnisName ?? '').trim();
  return name || 'Unnamed';
}

function shortCreekName(name) {
  return name.replace(/\s+Creek$/i, '');
}

function bboxCenter(coords) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return {
    lon: (minLon + maxLon) / 2,
    lat: (minLat + maxLat) / 2,
  };
}

function fillMissingValleyElevations(centerline) {
  const values = centerline.map((pt) => pt.valleyMinElevationM);
  let lastValid = Number.NaN;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) lastValid = values[i];
    else if (Number.isFinite(lastValid)) values[i] = lastValid;
  }
  lastValid = Number.NaN;
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) lastValid = values[i];
    else if (Number.isFinite(lastValid)) values[i] = lastValid;
  }
  return centerline.map((pt, i) => ({
    ...pt,
    valleyMinElevationM: values[i],
  }));
}

async function fetchSamplesBatch(batch, attempt = 1) {
  const geometry = JSON.stringify({
    points: batch.map((p) => [p.lon, p.lat]),
    spatialReference: { wkid: 4326 },
  });
  const body = new URLSearchParams({
    geometry,
    geometryType: 'esriGeometryMultipoint',
    returnFirstValueOnly: 'true',
    f: 'json',
  });

  const res = await fetch(`${USGS_ELEVATION_URL}/getSamples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    if (attempt < 3) {
      await sleep(400 * attempt);
      return fetchSamplesBatch(batch, attempt + 1);
    }
    throw new Error(`USGS 3DEP getSamples failed: ${res.status}`);
  }

  const json = await res.json();
  return json.samples ?? [];
}

async function sampleElevationsLonLat(points) {
  const elevations = new Array(points.length);
  const batches = [];
  for (let start = 0; start < points.length; start += GET_SAMPLES_BATCH) {
    batches.push({ start, batch: points.slice(start, start + GET_SAMPLES_BATCH) });
  }

  for (let i = 0; i < batches.length; i += USGS_CONCURRENCY) {
    const slice = batches.slice(i, i + USGS_CONCURRENCY);
    await Promise.all(
      slice.map(async ({ start, batch }) => {
        const samples = await fetchSamplesBatch(batch);
        if (samples.length !== batch.length) {
          throw new Error(
            `USGS 3DEP getSamples returned ${samples.length} samples for ${batch.length} points`,
          );
        }
        for (const sample of samples) {
          const batchIndex = sample.locationId;
          const value = Number.parseFloat(sample.value);
          elevations[start + batchIndex] = Number.isFinite(value) ? value : Number.NaN;
        }
      }),
    );
    const done = Math.min(i + USGS_CONCURRENCY, batches.length);
    if (done === batches.length || done % 8 === 0) {
      console.log(`  3DEP batches ${done}/${batches.length}`);
    }
  }

  return elevations;
}

async function computeValleyMinProfiles(reaches) {
  const probePoints = [];
  const owners = [];
  for (let r = 0; r < reaches.length; r++) {
    const centerline = reaches[r].centerline;
    for (let i = 0; i < centerline.length; i++) {
      const probes = crossSectionProbePoints(centerline, i);
      for (const probe of probes) {
        probePoints.push(probe);
        owners.push({ r, i });
      }
    }
  }

  console.log(
    `Querying USGS 3DEP for ${probePoints.length} cross-section samples (${reaches.reduce((n, reach) => n + reach.centerline.length, 0)} stations × ${PROBE_DISTANCES_M.length} probes)…`,
  );

  const elevations = await sampleElevationsLonLat(probePoints);
  const mins = reaches.map((reach) =>
    reach.centerline.map(() => ({ min: Infinity, any: false })),
  );

  for (let p = 0; p < elevations.length; p++) {
    const value = elevations[p];
    if (!Number.isFinite(value)) continue;
    const { r, i } = owners[p];
    mins[r][i].min = Math.min(mins[r][i].min, value);
    mins[r][i].any = true;
  }

  return reaches.map((reach, r) => {
    const withValley = reach.centerline.map((pt, i) => ({
      ...pt,
      valleyMinElevationM: mins[r][i].any ? mins[r][i].min : Number.NaN,
    }));
    return {
      ...reach,
      centerline: fillMissingValleyElevations(withValley),
    };
  });
}

/**
 * Named streams plus unnamed perennial (FCODE 46006). All 105 Preserve
 * flowlines (~139 km) include 84 intermittent draws and read as a drainage
 * spiderweb at this scale. Unnamed GNIS_NAME is a single space, not NULL.
 * Do not filter on MAJOR_RIVE=1 — that drops Espada and Gasper.
 * maxRecordCount is 2000, so one request is enough.
 */
async function fetchPreserveCreeks() {
  const params = new URLSearchParams({
    where: "GNIS_NAME NOT IN (' ','') OR FCODE=46006",
    outFields: 'FID,COMID,GNIS_NAME,LENGTHKM,FCODE,FTYPE,MAJOR_RIVE,REACHCODE,FLOWDIR',
    f: 'geojson',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '2000',
  });

  const res = await fetch(`${CENTERLINE_URL}?${params}`);
  if (!res.ok) throw new Error(`Centerline fetch failed: ${res.status}`);
  const geojson = await res.json();
  const features = geojson.features ?? [];
  if (!features.length) throw new Error('No Preserve creek features returned');

  const sample = features[0]?.geometry?.coordinates;
  const first = Array.isArray(sample?.[0]) && Array.isArray(sample[0][0]) ? sample[0][0] : sample?.[0];
  if (!first || first[0] < -130 || first[0] > -110 || first[1] < 30 || first[1] > 40) {
    throw new Error(
      `Centerline is not WGS84 lon/lat (got ${first}). Query must use outSR=4326 — native CRS is State Plane feet.`,
    );
  }

  return features.filter((feature) => feature.properties?.FCODE !== CONNECTOR_FCODE);
}

function buildDraftReaches(features, originLon, originLat) {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  const reaches = [];

  for (const feature of features) {
    const name = displayReachName(feature.properties?.GNIS_NAME);
    const comid = Number.isFinite(feature.properties?.COMID)
      ? feature.properties.COMID
      : null;

    for (const coords of lineParts(feature.geometry)) {
      const lonLat = coords.map(([lon, lat]) => [lon, lat]);
      if (lonLat.length < 2) continue;

      const rawLocal = lonLat.map(([lon, lat]) =>
        lonLatToLocalM(lon, lat, originLon, originLat),
      );
      let sampled = resampleLine(rawLocal, SAMPLE_SPACING_M);
      if (TRIM_REACH_M > 0) sampled = trimReach(sampled, TRIM_REACH_M);
      if (sampled.length < 2) continue;

      reaches.push({
        comid,
        name,
        lengthM: sampled.at(-1)?.chainageM ?? 0,
        centerline: sampled.map((pt) => ({
          ...pt,
          lon: originLon + pt.x / mPerDegLon,
          lat: originLat + pt.y / mPerDegLat,
        })),
      });
    }
  }

  return reaches;
}

async function main() {
  const stagesOnly = process.argv.includes('--stages-only');

  if (stagesOnly && existsSync(OUT_PATH)) {
    console.log(`Updating stage metadata on ${OUT_PATH} (ribbons rebuild at runtime)…`);
    const existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    if (!existing.reaches?.length) {
      throw new Error('Existing reach.json has no reaches — run full generate-data first');
    }
    existing.meta.maxStageFt = MAX_STAGE_FT;
    existing.meta.stages = STAGES;
    existing.meta.halfWidthBaseM = BASE_HALF_WIDTH_M;
    if (existing.meta.valleyBottomSampling) {
      existing.meta.valleyBottomSampling.halfWidthBaseM = BASE_HALF_WIDTH_M;
    }
    delete existing.waterStages;
    writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2));
    console.log(`Updated ${OUT_PATH} stages (0–${MAX_STAGE_FT} ft), ${existing.reaches.length} reaches`);
    return;
  }

  console.log('Fetching named + perennial Preserve creeks from TNC NHD 1:24k…');
  const features = await fetchPreserveCreeks();
  const allCoords = features.flatMap((feature) =>
    lineParts(feature.geometry).flatMap((part) => part.map(([lon, lat]) => [lon, lat])),
  );
  const origin = bboxCenter(allCoords);
  const draftReaches = buildDraftReaches(features, origin.lon, origin.lat);
  if (!draftReaches.length) throw new Error('No usable reach geometries after resample');

  const reaches = await computeValleyMinProfiles(draftReaches);
  const usable = reaches.filter((reach) =>
    reach.centerline.every((pt) => Number.isFinite(pt.valleyMinElevationM)),
  );
  if (!usable.length) throw new Error('No reaches with valid 3DEP valley elevations');

  const valleyStats = usable.flatMap((reach) =>
    reach.centerline.map((pt) => pt.valleyMinElevationM),
  );
  const minValley = Math.min(...valleyStats);
  const maxValley = Math.max(...valleyStats);
  const totalLengthM = usable.reduce((sum, reach) => sum + reach.lengthM, 0);
  const namedCreeks = [...new Set(
    usable.map((reach) => shortCreekName(reach.name)).filter((name) => name !== 'Unnamed'),
  )].sort();

  const payload = {
    meta: {
      name: 'Dangermond Preserve creek network',
      source: {
        centerline:
          'REAL — TNC JLDP NHD 1:24k flowlines FeatureServer/7 (named streams + unnamed perennial; outSR=4326)',
        centerlineUrl: CENTERLINE_URL,
        elevation: 'REAL — USGS 3DEP ImageServer getSamples (valley-bottom cross-section minimum)',
        elevationUrl: USGS_ELEVATION_URL,
        waterGeometry:
          'REAL — absolute-height ribbon at valley minimum + stage offset; drapes on 3DEP terrain',
        verticalDatum: 'NAVD88 meters (USGS 3DEP)',
      },
      valleyBottomSampling: {
        method: 'Perpendicular probes at each centerline station; minimum elevation defines thalweg',
        probeDistancesM: PROBE_DISTANCES_M,
        halfWidthBaseM: BASE_HALF_WIDTH_M,
        elevationRangeM: {
          min: Number(minValley.toFixed(3)),
          max: Number(maxValley.toFixed(3)),
        },
      },
      originWgs84: origin,
      totalLengthM: Math.round(totalLengthM),
      reachCount: usable.length,
      halfWidthBaseM: BASE_HALF_WIDTH_M,
      namedCreeks,
      maxStageFt: MAX_STAGE_FT,
      stages: STAGES,
      approach: 'Offline USGS 3DEP valley-bottom water mesh + ArcGIS SceneView absolute-height',
      apiKeyRequired: false,
    },
    reaches: usable.map((reach) => ({
      comid: reach.comid,
      name: reach.name,
      lengthM: Math.round(reach.lengthM),
      centerline: reach.centerline.map(({ x, y, chainageM, lon, lat, valleyMinElevationM }) => ({
        x,
        y,
        chainageM,
        lon,
        lat,
        valleyMinElevationM,
      })),
    })),
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(
    `Wrote ${OUT_PATH} (${usable.length} reaches, ${(totalLengthM / 1000).toFixed(1)} km, ${usable.reduce((n, reach) => n + reach.centerline.length, 0)} stations, valley ${minValley.toFixed(1)}–${maxValley.toFixed(1)} m)`,
  );
  console.log(`Named creeks: ${namedCreeks.join(', ') || '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
