/**
 * Fetches Escondido Creek centerline from TNC public FeatureServer,
 * projects a short reach to local meters, synthesizes terrain, and
 * precomputes sloped water ribbon meshes at discrete stages.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '../public/data/reach.json');
const CENTERLINE_URL =
  'https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_nhd24kflowlines_streams/FeatureServer/7/query';

const STAGES = [
  { id: 'baseline', label: 'Baseline (+0 m)', offsetM: 0 },
  { id: 'plus-0.25', label: '+0.25 m', offsetM: 0.25 },
  { id: 'plus-0.5', label: '+0.5 m', offsetM: 0.5 },
  { id: 'plus-1.0', label: '+1.0 m', offsetM: 1.0 },
];

const TARGET_REACH_M = 350;
const SAMPLE_SPACING_M = 8;
const BASE_HALF_WIDTH_M = 4;
const WIDTH_GROWTH_PER_M_STAGE = 1.8;
const BASE_WATER_ABOVE_BED_M = 0.35;
const DOWNSTREAM_DROP_M_PER_100M = 1.2;

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

function syntheticBedElevation(chainageM, x, y) {
  const downstreamDrop = (chainageM / 100) * DOWNSTREAM_DROP_M_PER_100M;
  const bankNoise = 0.4 * Math.sin(chainageM / 22) + 0.25 * Math.cos(x / 18);
  return 42.5 - downstreamDrop + bankNoise + 0.15 * Math.sin(y / 12);
}

function buildRibbonMesh(centerline, stageOffsetM) {
  const positions = [];
  const indices = [];
  const halfWidth =
    BASE_HALF_WIDTH_M + stageOffsetM * WIDTH_GROWTH_PER_M_STAGE;

  for (let i = 0; i < centerline.length; i++) {
    const pt = centerline[i];
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(centerline.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;

    const bedZ = syntheticBedElevation(pt.chainageM, pt.x, pt.y);
    const waterZ = bedZ + BASE_WATER_ABOVE_BED_M + stageOffsetM;

    const left = { x: pt.x + nx * halfWidth, y: pt.y + ny * halfWidth, z: waterZ };
    const right = { x: pt.x - nx * halfWidth, y: pt.y - ny * halfWidth, z: waterZ };

    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
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

function buildTerrainStrip(centerline) {
  const positions = [];
  const indices = [];
  const halfWidth = BASE_HALF_WIDTH_M + 12;

  for (let i = 0; i < centerline.length; i++) {
    const pt = centerline[i];
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(centerline.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;

    const bedZ = syntheticBedElevation(pt.chainageM, pt.x, pt.y);
    const bankBoost = 1.5 + 0.3 * Math.sin(pt.chainageM / 30);

    positions.push(
      pt.x + nx * halfWidth,
      pt.y + ny * halfWidth,
      bedZ + bankBoost,
      pt.x - nx * halfWidth,
      pt.y - ny * halfWidth,
      bedZ + bankBoost,
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
  console.log('Fetching Escondido Creek centerline from TNC public service...');
  const segment = await fetchEscondidoSegment();

  const originLon = segment.coords[0][0];
  const originLat = segment.coords[0][1];

  const rawLocal = segment.coords.map(([lon, lat]) =>
    lonLatToLocalM(lon, lat, originLon, originLat),
  );

  const resampled = resampleLine(rawLocal, SAMPLE_SPACING_M);
  const reach = trimReach(resampled, TARGET_REACH_M);

  const centerline = reach.map((pt, i) => ({
    ...pt,
    chainageM: pt.chainageM ?? (i === 0 ? 0 : reach[i].chainageM),
    lon: segment.coords[0][0],
    lat: segment.coords[0][1],
  }));

  // Attach source lon/lat per point by re-projecting from local (approx inverse)
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  centerline.forEach((pt) => {
    pt.lon = originLon + pt.x / mPerDegLon;
    pt.lat = originLat + pt.y / mPerDegLat;
  });

  const reachLengthM = centerline.at(-1)?.chainageM ?? 0;

  const payload = {
    meta: {
      name: 'Escondido Creek reach (POC)',
      source: {
        centerline: 'REAL — TNC JLDP NHD flowlines FeatureServer/7 (Escondido Creek)',
        centerlineUrl: CENTERLINE_URL,
        terrain: 'MOCK — synthetic bed profile with downstream slope (~1.2 m/100 m) and noise',
        waterGeometry: 'MOCK — fixed-width ribbon widened per stage; not terrain-clipped inundation',
        verticalDatum: 'Approximate NAVD88-like meters (synthetic baseline ~42.5 m)',
      },
      originWgs84: { lon: originLon, lat: originLat },
      reachLengthM: Math.round(reachLengthM),
      comid: segment.properties.COMID,
      stages: STAGES,
      approach: 'Three.js sloped water mesh (T4 comparison path)',
      apiKeyRequired: false,
    },
    centerline: centerline.map(({ x, y, chainageM, lon, lat }) => ({ x, y, chainageM, lon, lat })),
    terrain: buildTerrainStrip(centerline),
    waterStages: Object.fromEntries(
      STAGES.map((stage) => [stage.id, buildRibbonMesh(centerline, stage.offsetM)]),
    ),
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT_PATH} (${reachLengthM.toFixed(0)} m reach, ${centerline.length} samples)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
