export interface StageDef {
  id: string;
  label: string;
  offsetM: number;
}

export interface MeshData {
  positions: number[];
  indices: number[];
}

export interface ReachData {
  meta: {
    name: string;
    source: Record<string, string>;
    originWgs84: { lon: number; lat: number };
    reachLengthM: number;
    comid: number;
    stages: StageDef[];
    approach: string;
    apiKeyRequired: boolean;
  };
  centerline: Array<{ x: number; y: number; chainageM: number; lon: number; lat: number }>;
  terrain: MeshData;
  waterStages: Record<string, MeshData>;
}
