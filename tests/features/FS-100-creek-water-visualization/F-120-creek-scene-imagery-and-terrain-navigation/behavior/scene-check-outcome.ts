import type { Page } from '../../../../support/browser/esri-response-cache.ts';
import { approvedExternalDisruptionEvidence } from '../../../../support/network/live-release-evidence.ts';
import {
  rethrowIfExternalOutage,
  type LiveServiceWatch,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';

const ABORTED_REQUEST = /ERR_ABORTED|\baborted\b/i;
const TRANSPORT_FAILURE =
  /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_CERT|ERR_SSL|ERR_TLS|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_TUNNEL|ERR_PROXY|ERR_EMPTY_RESPONSE|ERR_SSL_PROTOCOL|NS_ERROR_NET|ECONNRESET|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|certificate|tls handshake/i;

const SCENE_TILE_REQUEST =
  /services\.arcgisonline\.com|server\.arcgisonline\.com|ibasemaps|elevation3d\.arcgis\.com|basemaps\.arcgis\.com|basemaps-api\.arcgis\.com/i;

export interface TerrainTraffic {
  successfulTiles: number;
  rateLimitedResponses: number;
  serverErrorResponses: number;
  transportFailures: string[];
}

export interface SidebarMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Counts Esri World Imagery and World Elevation outcomes, including responses served from the cache. */
export function watchTerrainTraffic(page: Page): TerrainTraffic {
  const traffic: TerrainTraffic = {
    successfulTiles: 0,
    rateLimitedResponses: 0,
    serverErrorResponses: 0,
    transportFailures: [],
  };
  page.on('response', (response) => {
    if (!SCENE_TILE_REQUEST.test(response.url())) return;
    const status = response.status();
    if (status === 429) traffic.rateLimitedResponses += 1;
    else if (status >= 500) traffic.serverErrorResponses += 1;
    else if (status >= 200 && status < 300) traffic.successfulTiles += 1;
  });
  page.on('requestfailed', (request) => {
    if (!SCENE_TILE_REQUEST.test(request.url())) return;
    const failure = request.failure()?.errorText ?? 'unknown request failure';
    if (ABORTED_REQUEST.test(failure) || !TRANSPORT_FAILURE.test(failure)) return;
    traffic.transportFailures.push(`${request.url()} ${failure}`);
  });
  return traffic;
}

export async function sidebarMask(page: Page): Promise<SidebarMask> {
  const box = await page.locator('aside').boundingBox();
  if (!box) throw new Error('The sidebar panel is missing, so the scene checks cannot avoid it.');
  return box;
}

function outageSummary(terrain: TerrainTraffic): string | null {
  const parts = [
    terrain.rateLimitedResponses ? `${terrain.rateLimitedResponses} HTTP 429 responses` : null,
    terrain.serverErrorResponses ? `${terrain.serverErrorResponses} HTTP 5xx responses` : null,
    terrain.transportFailures[0] ?? null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join('; ') : null;
}

/**
 * A measured scene failure is reported as a failure even when Esri also had trouble.
 * Only a run whose frames all passed can become inconclusive, because a missing tile
 * could have hidden the bug.
 */
export function finishSceneCheck(
  failures: readonly string[],
  terrain: TerrainTraffic,
  watch: LiveServiceWatch,
): void {
  const outage = outageSummary(terrain);
  if (failures.length > 0) {
    const note = outage ? [`Esri also reported ${outage} during this run; the measured failure stands.`] : [];
    throw new Error([...failures, ...note].join('\n'));
  }
  if (outage) throw new Error(`INCONCLUSIVE: ${outage}`);
  if (terrain.successfulTiles === 0) {
    const evidence = approvedExternalDisruptionEvidence({
      message: 'no imagery or elevation tiles arrived',
      pageErrors: watch.pageErrors,
      network: watch.summarize(),
    });
    throw new Error(
      `INCONCLUSIVE: no imagery or elevation tiles arrived. ${evidence ?? 'The frame never drew terrain.'}`,
    );
  }
}

/** Measured scene failures come first; an outage only explains a run that measured nothing wrong. */
export function rethrowSceneFailure(
  error: unknown,
  failures: readonly string[],
  watch: LiveServiceWatch,
): never {
  if (failures.length > 0) {
    const detail = error instanceof Error ? error.message : String(error);
    const report = failures.join('\n');
    throw new Error(detail.includes(failures[0] ?? report) ? detail : `${report}\n${detail}`, {
      cause: error,
    });
  }
  if (error instanceof Error && error.message.startsWith('INCONCLUSIVE:')) throw error;
  rethrowIfExternalOutage(watch, error);
}
