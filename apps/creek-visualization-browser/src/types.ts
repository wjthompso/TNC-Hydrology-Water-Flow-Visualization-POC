export interface StageDef {
  id: string;
  label: string;
  offsetM: number;
}

export interface MeshData {
  positions: number[];
  indices: number[];
}

export interface CenterlineStation {
  x: number;
  y: number;
  chainageM: number;
  lon: number;
  lat: number;
  valleyMinElevationM: number;
}

export interface NetworkReach {
  comid: number | null;
  name: string;
  lengthM: number;
  centerline: CenterlineStation[];
}

export interface NetworkData {
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
    totalLengthM: number;
    reachCount: number;
    halfWidthBaseM: number;
    namedCreeks: string[];
    maxStageFt?: number;
    stages: StageDef[];
    approach: string;
    apiKeyRequired: boolean;
  };
  reaches: NetworkReach[];
}

export function allCenterlineStations(data: NetworkData): CenterlineStation[] {
  return data.reaches.flatMap((reach) => reach.centerline);
}
