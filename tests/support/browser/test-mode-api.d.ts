import type { ArcGISTestReferences } from '../../../apps/creek-visualization-browser/src/arcgis-scene';

declare global {
  interface Window {
    __TNC_TEST__?: {
      getState: () => Readonly<{
        renderer: 'arcgis' | 'three';
        stageOffsetM: number;
      }>;
      getArcGISReferences: () => ArcGISTestReferences;
    };
  }
}

export {};
