import type { NetworkData } from './types';

/** Shared contract for Three.js and ArcGIS renderers. */
export interface SceneBackend {
  load(data: NetworkData): void | Promise<void>;
  setStage(stageId: string): void;
  setStageOffsetM(offsetM: number): void;
  destroy(): void;
}
