import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData, ReachData } from './types';
import type { SceneBackend } from './scene-backend';

/** Map local meters (x, y) + elevation z to Three.js Y-up coordinates. */
function toThreeVector(x: number, y: number, elevation: number): THREE.Vector3 {
  return new THREE.Vector3(x, elevation, -y);
}

function meshFromData(data: MeshData, material: THREE.Material): THREE.Mesh {
  const remapped = new Float32Array(data.positions.length);
  for (let i = 0; i < data.positions.length; i += 3) {
    const v = toThreeVector(data.positions[i], data.positions[i + 1], data.positions[i + 2]);
    remapped[i] = v.x;
    remapped[i + 1] = v.y;
    remapped[i + 2] = v.z;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(remapped, 3));
  geometry.setIndex(data.indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function centerlineToLine(data: ReachData): THREE.Line {
  const baseline = data.waterStages.baseline;
  const points = data.centerline.map((pt, i) => {
    const vi = i * 6;
    const leftZ = baseline.positions[vi + 2] - 0.35;
    return toThreeVector(pt.x, pt.y, leftZ);
  });
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0xfbbf24 });
  return new THREE.Line(geometry, material);
}

export class CreekScene implements SceneBackend {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private waterMeshes = new Map<string, THREE.Mesh>();
  private activeStageId: string | null = null;
  private container: HTMLElement;
  private rafId = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x0f172a, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      2000,
    );

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.05;

    const ambient = new THREE.AmbientLight(0xbfd7ff, 0.55);
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(80, 120, 60);
    this.scene.add(ambient, sun);

    window.addEventListener('resize', this.onResize);
  }

  load(data: ReachData): void {
    const terrainMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b5b4a,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
    });

    const waterMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x1d9bf0,
      transparent: true,
      opacity: 0.72,
      roughness: 0.15,
      metalness: 0.05,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
      side: THREE.DoubleSide,
    });

    this.scene.add(meshFromData(data.terrain, terrainMaterial));
    this.scene.add(centerlineToLine(data));

    for (const stage of data.meta.stages) {
      const mesh = meshFromData(data.waterStages[stage.id], waterMaterial.clone());
      mesh.visible = false;
      mesh.name = `water-${stage.id}`;
      this.waterMeshes.set(stage.id, mesh);
      this.scene.add(mesh);
    }

    this.frameCamera();
    this.setStage(data.meta.stages[0].id);
    this.animate();
  }

  setStage(stageId: string): void {
    if (this.activeStageId === stageId) return;

    for (const [id, mesh] of this.waterMeshes) {
      mesh.visible = id === stageId;
    }
    this.activeStageId = stageId;
  }

  private frameCamera(): void {
    const bounds = new THREE.Box3();
    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox) {
          bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
        }
      }
    });

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 80);

    this.camera.position.set(
      center.x - span * 0.75,
      center.y + span * 0.55,
      center.z + span * 0.85,
    );
    this.controls.target.copy(center);
    this.controls.update();
  }

  private onResize = (): void => {
    const { clientWidth, clientHeight } = this.container;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight);
  };

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
