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
    valleyBottomSampling?: {
      method: string;
      probeDistancesM: number[];
      halfWidthBaseM: number;
      elevationRangeM: { min: number; max: number };
    };
    originWgs84: { lon: number; lat: number };
    reachLengthM: number;
    comid: number;
    maxStageFt?: number;
    stages: StageDef[];
    approach: string;
    apiKeyRequired: boolean;
  };
  centerline: Array<{
    x: number;
    y: number;
    chainageM: number;
    lon: number;
    lat: number;
    valleyMinElevationM: number;
  }>;
  terrain?: MeshData;
  waterStages: Record<string, MeshData>;
}
