/**
 * Fetches Escondido Creek centerline from TNC public FeatureServer,
 * samples USGS 3DEP valley-bottom elevation along the reach, and
 * precomputes water ribbon meshes at discrete stages (absolute meters).
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

const TARGET_REACH_M = 350;
const SAMPLE_SPACING_M = 8;
const BASE_HALF_WIDTH_M = 4;
const WIDTH_GROWTH_PER_M_STAGE = 1.8;
const PROBE_DISTANCES_M = [0];
for (const d of [4, 8, 12, 16, 20, 24, 28, 30]) {
  PROBE_DISTANCES_M.push(d, -d);
}
const GET_SAMPLES_BATCH = 100;

function haversineM(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

async function sampleElevationsLonLat(points) {
  const elevations = new Array(points.length);

  for (let start = 0; start < points.length; start += GET_SAMPLES_BATCH) {
    const batch = points.slice(start, start + GET_SAMPLES_BATCH);
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
      throw new Error(`USGS 3DEP getSamples failed: ${res.status}`);
    }

    const json = await res.json();
    const samples = json.samples ?? [];
    if (samples.length !== batch.length) {
      throw new Error(
        `USGS 3DEP getSamples returned ${samples.length} samples for ${batch.length} points`,
      );
    }

    for (const sample of samples) {
      const batchIndex = sample.locationId;
      const globalIndex = start + batchIndex;
      const value = Number.parseFloat(sample.value);
      if (!Number.isFinite(value)) {
        const pt = batch[batchIndex];
        throw new Error(`NoData elevation at lon=${pt.lon}, lat=${pt.lat}`);
      }
      elevations[globalIndex] = value;
    }
  }

  return elevations;
}

async function computeValleyMinProfile(centerline) {
  const probePoints = centerline.flatMap((_, index) => crossSectionProbePoints(centerline, index));
  console.log(
    `Querying USGS 3DEP for ${probePoints.length} cross-section samples (${centerline.length} stations × ${PROBE_DISTANCES_M.length} probes)…`,
  );

  const elevations = await sampleElevationsLonLat(probePoints);
  const probesPerStation = PROBE_DISTANCES_M.length;

  return centerline.map((pt, index) => {
    const start = index * probesPerStation;
    const stationElevations = elevations.slice(start, start + probesPerStation);
    const valleyMinElevationM = Math.min(...stationElevations);
    return { ...pt, valleyMinElevationM };
  });
}

function buildRibbonMesh(centerline, stageOffsetM) {
  const positions = [];
  const indices = [];
  const halfWidth = BASE_HALF_WIDTH_M + stageOffsetM * WIDTH_GROWTH_PER_M_STAGE;

  for (let i = 0; i < centerline.length; i++) {
    const pt = centerline[i];
    const { nx, ny } = perpendicularUnitNormal(centerline, i);
    const waterZ = pt.valleyMinElevationM + stageOffsetM;

    positions.push(
      pt.x + nx * halfWidth,
      pt.y + ny * halfWidth,
      waterZ,
      pt.x - nx * halfWidth,
      pt.y - ny * halfWidth,
      waterZ,
    );
  }

  for (let i = 0; i < centerline.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }

  return { positions, indices };
}

async function fetchEscondidoSegment() {
  const params = new URLSearchParams({
    where: "GNIS_NAME = 'Escondido Creek'",
    outFields: 'GNIS_NAME,COMID,LENGTHKM',
    f: 'geojson',
    returnGeometry: 'true',
    resultRecordCount: '50',
  });

  const res = await fetch(`${CENTERLINE_URL}?${params}`);
  if (!res.ok) throw new Error(`Centerline fetch failed: ${res.status}`);
  const geojson = await res.json();

  const features = geojson.features ?? [];
  if (!features.length) throw new Error('No Escondido Creek features returned');

  let best = null;
  let bestLen = 0;

  for (const feature of features) {
    const coords = feature.geometry.coordinates;
    const len = haversineM(coords[0][0], coords[0][1], coords.at(-1)[0], coords.at(-1)[1]);
    if (len > bestLen) {
      bestLen = len;
      best = { coords, properties: feature.properties };
    }
  }

  return best;
}

async function main() {
  const stagesOnly = process.argv.includes('--stages-only');

  if (stagesOnly && existsSync(OUT_PATH)) {
    console.log(`Rebuilding water stages from existing ${OUT_PATH} (skipping USGS 3DEP)…`);
    const existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const centerline = existing.centerline;
    if (!centerline?.length) {
      throw new Error('Existing reach.json has no centerline — run full generate-data first');
    }

    existing.meta.maxStageFt = MAX_STAGE_FT;
    existing.meta.stages = STAGES;
    existing.waterStages = Object.fromEntries(
      STAGES.map((stage) => [stage.id, buildRibbonMesh(centerline, stage.offsetM)]),
    );

    writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2));
    console.log(
      `Updated ${OUT_PATH} with ${STAGES.length} stages (0–${MAX_STAGE_FT} ft), ${centerline.length} stations`,
    );
    return;
  }

  console.log('Fetching Escondido Creek centerline from TNC public service...');
  const segment = await fetchEscondidoSegment();

  const originLon = segment.coords[0][0];
  const originLat = segment.coords[0][1];

  const rawLocal = segment.coords.map(([lon, lat]) =>
    lonLatToLocalM(lon, lat, originLon, originLat),
  );

  const resampled = resampleLine(rawLocal, SAMPLE_SPACING_M);
  const reach = trimReach(resampled, TARGET_REACH_M);

  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  const centerlineDraft = reach.map((pt) => ({
    ...pt,
    lon: originLon + pt.x / mPerDegLon,
    lat: originLat + pt.y / mPerDegLat,
  }));

  const centerline = await computeValleyMinProfile(centerlineDraft);
  const reachLengthM = centerline.at(-1)?.chainageM ?? 0;
  const valleyStats = centerline.map((pt) => pt.valleyMinElevationM);
  const minValley = Math.min(...valleyStats);
  const maxValley = Math.max(...valleyStats);

  const payload = {
    meta: {
      name: 'Escondido Creek reach (POC)',
      source: {
        centerline: 'REAL — TNC JLDP NHD flowlines FeatureServer/7 (Escondido Creek)',
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
      originWgs84: { lon: originLon, lat: originLat },
      reachLengthM: Math.round(reachLengthM),
      comid: segment.properties.COMID,
      maxStageFt: MAX_STAGE_FT,
      stages: STAGES,
      approach: 'Offline USGS 3DEP valley-bottom water mesh + ArcGIS SceneView absolute-height',
      apiKeyRequired: false,
    },
    centerline: centerline.map(({ x, y, chainageM, lon, lat, valleyMinElevationM }) => ({
      x,
      y,
      chainageM,
      lon,
      lat,
      valleyMinElevationM,
    })),
    waterStages: Object.fromEntries(
      STAGES.map((stage) => [stage.id, buildRibbonMesh(centerline, stage.offsetM)]),
    ),
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(
    `Wrote ${OUT_PATH} (${reachLengthM.toFixed(0)} m reach, ${centerline.length} stations, valley ${minValley.toFixed(1)}–${maxValley.toFixed(1)} m)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
