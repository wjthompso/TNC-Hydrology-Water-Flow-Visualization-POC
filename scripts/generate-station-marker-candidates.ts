/**
 * Writes low-polygon GLB (binary glTF 2.0) station marker models for UCS-261
 * into the browser app's public folder. `stream-gauge-mast.glb` is the chosen
 * gauge marker; the rest appear in the dev tools Station marker gallery.
 *
 * Models are Y-up, in meters, with the origin at ground level under the
 * installed equipment. ArcGIS ObjectSymbol3DLayer converts Y-up glTF to its
 * Z-up scene and anchors the model at that origin.
 *
 * Each model has one white "status" material. With `colorMixMode: 'tint'`,
 * a status color shows fully on that part and darkens the other parts.
 *
 * Run: node --experimental-strip-types scripts/generate-station-marker-candidates.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Vec3 = readonly [number, number, number];

interface MaterialSpec {
  name: string;
  rgba: readonly [number, number, number, number];
  metallic?: number;
  roughness?: number;
}

const MATERIALS = {
  status: { name: 'status', rgba: [0.95, 0.95, 0.95, 1], roughness: 0.6 },
  metal: { name: 'metal', rgba: [0.55, 0.57, 0.6, 1], metallic: 0.6, roughness: 0.45 },
  concrete: { name: 'concrete', rgba: [0.62, 0.6, 0.56, 1], roughness: 0.95 },
  solarCell: { name: 'solar-cell', rgba: [0.08, 0.14, 0.32, 1], metallic: 0.3, roughness: 0.25 },
  black: { name: 'black', rgba: [0.06, 0.06, 0.07, 1], roughness: 0.5 },
  wood: { name: 'wood', rgba: [0.45, 0.3, 0.17, 1], roughness: 0.9 },
  camo: { name: 'camo', rgba: [0.33, 0.36, 0.22, 1], roughness: 0.85 },
  gaugeRed: { name: 'gauge-red', rgba: [0.78, 0.12, 0.1, 1], roughness: 0.6 },
  viewCone: { name: 'view-cone', rgba: [1, 1, 1, 0.22], roughness: 1 },
} as const satisfies Record<string, MaterialSpec>;

type MaterialKey = keyof typeof MATERIALS;

/** Collects flat-shaded triangles grouped by material. */
class LowPolyModel {
  readonly trianglesByMaterial = new Map<MaterialKey, number[]>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  triangle(material: MaterialKey, a: Vec3, b: Vec3, c: Vec3): void {
    // A cone tip makes zero-area triangles; they have no valid normal.
    if (magnitude(cross(sub(b, a), sub(c, a))) < 1e-9) return;
    const list = this.trianglesByMaterial.get(material) ?? [];
    list.push(...a, ...b, ...c);
    this.trianglesByMaterial.set(material, list);
  }

  quad(material: MaterialKey, a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.triangle(material, a, b, c);
    this.triangle(material, a, c, d);
  }

  /** Axis-aligned box, then rotated about its center and moved. */
  box(material: MaterialKey, center: Vec3, size: Vec3, rotation: Rotation = NO_ROTATION): void {
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const corner = (x: number, y: number, z: number): Vec3 =>
      add(center, rotate([x * hx, y * hy, z * hz], rotation));
    const p = {
      lbf: corner(-1, -1, 1), rbf: corner(1, -1, 1), rtf: corner(1, 1, 1), ltf: corner(-1, 1, 1),
      lbb: corner(-1, -1, -1), rbb: corner(1, -1, -1), rtb: corner(1, 1, -1), ltb: corner(-1, 1, -1),
    };
    this.quad(material, p.lbf, p.rbf, p.rtf, p.ltf); // front (+z)
    this.quad(material, p.rbb, p.lbb, p.ltb, p.rtb); // back (-z)
    this.quad(material, p.lbb, p.lbf, p.ltf, p.ltb); // left (-x)
    this.quad(material, p.rbf, p.rbb, p.rtb, p.rtf); // right (+x)
    this.quad(material, p.ltf, p.rtf, p.rtb, p.ltb); // top (+y)
    this.quad(material, p.lbb, p.rbb, p.rbf, p.lbf); // bottom (-y)
  }

  /** Capped frustum from `from` to `to`; radius 0 at either end makes a cone. */
  frustum(
    material: MaterialKey,
    from: Vec3,
    to: Vec3,
    radiusFrom: number,
    radiusTo: number,
    segments = 8,
  ): void {
    const axis = sub(to, from);
    const rotation = rotationFromYTo(normalize(axis));
    const length = magnitude(axis);
    const ring = (radius: number, y: number): Vec3[] =>
      Array.from({ length: segments }, (_, i) => {
        const angle = (i / segments) * Math.PI * 2;
        return add(from, rotate([radius * Math.cos(angle), y, -radius * Math.sin(angle)], rotation));
      });
    const bottom = ring(radiusFrom, 0);
    const top = ring(radiusTo, length);
    const bottomCenter = from;
    const topCenter = to;
    for (let i = 0; i < segments; i += 1) {
      const next = (i + 1) % segments;
      this.quad(material, bottom[i], bottom[next], top[next], top[i]);
      if (radiusFrom > 0) this.triangle(material, bottomCenter, bottom[next], bottom[i]);
      if (radiusTo > 0) this.triangle(material, topCenter, top[i], top[next]);
    }
  }

  cylinder(material: MaterialKey, from: Vec3, to: Vec3, radius: number, segments = 8): void {
    this.frustum(material, from, to, radius, radius, segments);
  }

  /** Low-polygon UV sphere. */
  sphere(material: MaterialKey, center: Vec3, radius: number, rings = 5, segments = 8): void {
    const point = (ring: number, segment: number): Vec3 => {
      const polar = (ring / rings) * Math.PI;
      const azimuth = (segment / segments) * Math.PI * 2;
      return add(center, [
        radius * Math.sin(polar) * Math.cos(azimuth),
        radius * Math.cos(polar),
        -radius * Math.sin(polar) * Math.sin(azimuth),
      ]);
    };
    for (let ring = 0; ring < rings; ring += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const a = point(ring, segment);
        const b = point(ring + 1, segment);
        const c = point(ring + 1, segment + 1);
        const d = point(ring, segment + 1);
        if (ring === 0) this.triangle(material, a, b, c);
        else if (ring === rings - 1) this.triangle(material, a, b, d);
        else this.quad(material, a, b, c, d);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate models
// ---------------------------------------------------------------------------

/** USGS-style gauge mast: radar water-level sensor arm, logger box, solar panel, antenna. */
function streamGaugeMast(): LowPolyModel {
  const model = new LowPolyModel('stream-gauge-mast');
  model.box('concrete', [0, 0.06, 0], [0.7, 0.12, 0.7]);
  model.cylinder('metal', [0, 0.12, 0], [0, 3.1, 0], 0.045);
  // Data logger enclosure: the status-colored part.
  model.box('status', [0, 1.25, 0.13], [0.42, 0.55, 0.2]);
  model.box('black', [0, 1.25, 0.235], [0.3, 0.06, 0.01]);
  // Radar arm reaching over the water, with the downward-looking sensor.
  model.box('metal', [0.55, 2.1, 0], [1.1, 0.05, 0.05]);
  model.cylinder('status', [1.05, 2.07, 0], [1.05, 1.9, 0], 0.09, 10);
  // Tilted solar panel facing +z.
  model.box('metal', [0, 2.55, 0.08], [0.06, 0.06, 0.16]);
  model.box('solarCell', [0, 2.6, 0.2], [0.7, 0.03, 0.5], { axis: [1, 0, 0], degrees: 35 });
  // Telemetry antenna.
  model.cylinder('black', [0, 3.1, 0], [0, 3.95, 0], 0.012, 6);
  model.sphere('status', [0, 3.98, 0], 0.045, 3, 6);
  return model;
}

/** Trail camera strapped to a post, with a translucent wedge showing where it points (+z). */
function trailCameraPost(): LowPolyModel {
  const model = new LowPolyModel('trail-camera-post');
  model.box('wood', [0, 0.75, 0], [0.1, 1.5, 0.1]);
  model.box('black', [0, 1.12, 0], [0.12, 0.03, 0.12]);
  // Camera body: the status-colored part.
  model.box('status', [0, 1.12, 0.1], [0.15, 0.22, 0.1]);
  model.box('camo', [0, 1.2, 0.152], [0.13, 0.05, 0.005]);
  model.cylinder('black', [0, 1.1, 0.15], [0, 1.1, 0.18], 0.03, 10);
  // Field-of-view wedge: 4 m long, roughly 50 degrees wide.
  const apex: Vec3 = [0, 1.1, 0.18];
  const far = 4;
  const halfWidth = far * Math.tan((25 * Math.PI) / 180);
  const halfHeight = halfWidth * 0.6;
  const corners: Vec3[] = [
    [-halfWidth, 1.1 - halfHeight, far],
    [halfWidth, 1.1 - halfHeight, far],
    [halfWidth, 1.1 + halfHeight, far],
    [-halfWidth, 1.1 + halfHeight, far],
  ];
  for (let i = 0; i < 4; i += 1) model.triangle('viewCone', apex, corners[i], corners[(i + 1) % 4]);
  return model;
}

/** Staff gauge: a striped water-level board on a post, the classic hydrology icon. */
function staffGaugeBoard(): LowPolyModel {
  const model = new LowPolyModel('staff-gauge-board');
  model.box('metal', [0, 0.9, -0.04], [0.08, 1.8, 0.05]);
  model.box('status', [0, 1.0, 0.0], [0.16, 1.5, 0.02]);
  // 0.1 m ticks alternating black and red, the way real enamel gauges read.
  for (let tick = 0; tick < 15; tick += 1) {
    const y = 0.3 + tick * 0.1;
    const material: MaterialKey = tick % 5 === 4 ? 'gaugeRed' : 'black';
    const width = tick % 5 === 4 ? 0.12 : 0.07;
    model.box(material, [-0.04 + (width - 0.07) / 2, y, 0.012], [width, 0.025, 0.005]);
  }
  model.box('status', [0, 1.83, 0.0], [0.22, 0.12, 0.03]);
  return model;
}

/** Abstract 3D map pin: reads at any distance and says "exactly here" without depicting hardware. */
function locationBeaconPin(): LowPolyModel {
  const model = new LowPolyModel('location-beacon-pin');
  // Ground ring marks the installed point.
  const segments = 16;
  const inner = 0.35;
  const outer = 0.55;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const ring = (radius: number, angle: number): Vec3 => [radius * Math.cos(angle), 0.02, -radius * Math.sin(angle)];
    model.quad('status', ring(inner, a0), ring(outer, a0), ring(outer, a1), ring(inner, a1));
  }
  // Inverted cone with its tip on the point, topped by a sphere head.
  model.frustum('status', [0, 0.05, 0], [0, 2.4, 0], 0, 0.32, 12);
  model.sphere('status', [0, 2.75, 0], 0.5, 6, 12);
  model.sphere('black', [0, 2.75, 0.42], 0.16, 4, 8);
  return model;
}

// ---------------------------------------------------------------------------
// GLB writer
// ---------------------------------------------------------------------------

function writeGlb(model: LowPolyModel, outputPath: string): { triangles: number; bytes: number } {
  const binaryParts: Buffer[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const primitives: object[] = [];
  const materials: object[] = [];
  let byteOffset = 0;
  let triangleCount = 0;

  const appendFloat32 = (values: number[], withBounds: boolean): number => {
    const data = Buffer.from(new Float32Array(values).buffer);
    binaryParts.push(data);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, target: 34962 });
    byteOffset += data.byteLength;
    const accessor: Record<string, unknown> = {
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: values.length / 3,
      type: 'VEC3',
    };
    if (withBounds) Object.assign(accessor, vectorBounds(values));
    accessors.push(accessor);
    return accessors.length - 1;
  };

  for (const [materialKey, positions] of model.trianglesByMaterial) {
    const spec: MaterialSpec = MATERIALS[materialKey];
    const translucent = spec.rgba[3] < 1;
    materials.push({
      name: spec.name,
      pbrMetallicRoughness: {
        baseColorFactor: spec.rgba,
        metallicFactor: spec.metallic ?? 0,
        roughnessFactor: spec.roughness ?? 0.8,
      },
      doubleSided: true,
      ...(translucent ? { alphaMode: 'BLEND' } : {}),
    });
    const positionAccessor = appendFloat32(positions, true);
    const normalAccessor = appendFloat32(flatNormals(positions), false);
    primitives.push({
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
      material: materials.length - 1,
      mode: 4,
    });
    triangleCount += positions.length / 9;
  }

  const binary = Buffer.concat(binaryParts);
  const gltf = {
    asset: { version: '2.0', generator: 'creek-water-visualization station marker candidates' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: model.name, mesh: 0 }],
    meshes: [{ name: model.name, primitives }],
    materials,
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews,
    accessors,
  };

  const jsonChunk = padTo4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
  const binChunk = padTo4(binary, 0x00);
  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const chunkHeader = (length: number, type: number): Buffer => {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(length, 0);
    buffer.writeUInt32LE(type, 4);
    return buffer;
  };
  const glb = Buffer.concat([
    header,
    chunkHeader(jsonChunk.byteLength, 0x4e4f534a), // "JSON"
    jsonChunk,
    chunkHeader(binChunk.byteLength, 0x004e4942), // "BIN\0"
    binChunk,
  ]);
  writeFileSync(outputPath, glb);
  return { triangles: triangleCount, bytes: glb.byteLength };
}

function flatNormals(positions: number[]): number[] {
  const normals: number[] = [];
  for (let i = 0; i < positions.length; i += 9) {
    const a: Vec3 = [positions[i], positions[i + 1], positions[i + 2]];
    const b: Vec3 = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const c: Vec3 = [positions[i + 6], positions[i + 7], positions[i + 8]];
    const n = normalize(cross(sub(b, a), sub(c, a)));
    normals.push(...n, ...n, ...n);
  }
  return normals;
}

function vectorBounds(values: number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], values[i + axis]);
      max[axis] = Math.max(max[axis], values[i + axis]);
    }
  }
  return { min, max };
}

function padTo4(buffer: Buffer, fill: number): Buffer {
  const padding = (4 - (buffer.byteLength % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding, fill)]);
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

interface Rotation {
  axis: Vec3;
  degrees: number;
}

const NO_ROTATION: Rotation = { axis: [0, 1, 0], degrees: 0 };

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function magnitude(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: Vec3): Vec3 {
  const length = magnitude(a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** Rodrigues rotation of `v` about a unit-normalized axis. */
function rotate(v: Vec3, { axis, degrees }: Rotation): Vec3 {
  if (degrees === 0) return v;
  const k = normalize(axis);
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const kCrossV = cross(k, v);
  const kDotV = dot(k, v);
  return [
    v[0] * cos + kCrossV[0] * sin + k[0] * kDotV * (1 - cos),
    v[1] * cos + kCrossV[1] * sin + k[1] * kDotV * (1 - cos),
    v[2] * cos + kCrossV[2] * sin + k[2] * kDotV * (1 - cos),
  ];
}

function rotationFromYTo(direction: Vec3): Rotation {
  const up: Vec3 = [0, 1, 0];
  const cosine = dot(up, direction);
  if (cosine > 0.9999) return NO_ROTATION;
  if (cosine < -0.9999) return { axis: [1, 0, 0], degrees: 180 };
  return { axis: cross(up, direction), degrees: (Math.acos(cosine) * 180) / Math.PI };
}

// ---------------------------------------------------------------------------

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(repositoryRoot, 'apps/creek-visualization-browser/public/station-marker-models');
mkdirSync(outputDirectory, { recursive: true });

for (const model of [streamGaugeMast(), trailCameraPost(), staffGaugeBoard(), locationBeaconPin()]) {
  const { triangles, bytes } = writeGlb(model, join(outputDirectory, `${model.name}.glb`));
  console.log(`${model.name}.glb  ${triangles} triangles  ${(bytes / 1024).toFixed(1)} KB`);
}
