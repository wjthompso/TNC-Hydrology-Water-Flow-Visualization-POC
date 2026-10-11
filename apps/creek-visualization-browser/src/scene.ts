import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { NetworkData } from './types';
import type { SceneBackend } from './scene-backend';
import { buildRibbonMesh } from './water-stage';

/** Map local meters (x, y) + elevation z to Three.js Y-up coordinates. */
function toThreeVector(x: number, y: number, elevation: number): THREE.Vector3 {
  return new THREE.Vector3(x, elevation, -y);
}

function meshFromData(
  positions: number[],
  indices: number[],
  material: THREE.Material,
): THREE.Mesh {
  const remapped = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const v = toThreeVector(positions[i], positions[i + 1], positions[i + 2]);
    remapped[i] = v.x;
    remapped[i + 1] = v.y;
    remapped[i + 2] = v.z;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(remapped, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export class CreekScene implements SceneBackend {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private waterMeshes: THREE.Mesh[] = [];
  private waterMaterial: THREE.MeshPhysicalMaterial | null = null;
  private networkData: NetworkData | null = null;
  private currentOffsetM = -1;
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
      1,
      80000,
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

  load(data: NetworkData): void {
    this.networkData = data;
    this.waterMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x1d9bf0,
      transparent: true,
      opacity: 0.72,
      roughness: 0.15,
      metalness: 0.05,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
      side: THREE.DoubleSide,
    });

    this.setStageOffsetM(0);
    this.frameCamera();
    this.animate();
  }

  setStage(stageId: string): void {
    const stage = this.networkData?.meta.stages.find((item) => item.id === stageId);
    if (stage) this.setStageOffsetM(stage.offsetM);
  }

  setStageOffsetM(offsetM: number): void {
    if (!this.networkData || !this.waterMaterial) return;
    if (Math.abs(this.currentOffsetM - offsetM) < 1e-6) return;

    this.currentOffsetM = offsetM;
    this.clearWaterMeshes();

    this.waterMeshes = this.networkData.reaches
      .filter((reach) => reach.centerline.length >= 2)
      .map((reach, index) => {
        const { positions, indices } = buildRibbonMesh(reach.centerline, offsetM);
        const mesh = meshFromData(positions, indices, this.waterMaterial!);
        mesh.name = `water-reach-${reach.comid ?? index}`;
        this.scene.add(mesh);
        return mesh;
      });
  }

  private clearWaterMeshes(): void {
    for (const mesh of this.waterMeshes) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    this.waterMeshes = [];
  }

  private frameCamera(): void {
    const bounds = new THREE.Box3();
    for (const mesh of this.waterMeshes) {
      mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox);
    }
    if (bounds.isEmpty()) return;

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
    this.clearWaterMeshes();
    this.waterMaterial?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.waterMaterial = null;
    this.networkData = null;
    this.currentOffsetM = -1;
  }
}
