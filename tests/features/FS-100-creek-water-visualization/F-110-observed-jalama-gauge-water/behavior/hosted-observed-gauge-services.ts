import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

/**
 * The public Dangermond Preserve ArcGIS services the observed Jalama gauge reads in a production build,
 * replayed from reviewed recordings in `tests/fixtures/recorded/hosted-observed-gauge`. Every fixture is a
 * real response of the live service, trimmed to the rows the gauge page needs.
 *
 * The replay answers by layer and request kind, not by exact query text, so a fix that asks the same
 * services a slightly different question still gets the recorded rows. A request to any other
 * Dangermond layer is recorded as unserved and the test fails on it.
 */

const HOSTED_ORIGIN = 'https://dangermondpreserve-spatial.com';
const SERVICES_PREFIX = '/server/rest/services/';

const fixtureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/recorded/hosted-observed-gauge',
);

const FIXTURE_FILES = [
  'modeled-wse-versions.json',
  'modeled-wse-creek-segments-27714637.json',
  'wse-polygon-versions.json',
  'wse-polygons-gauge-neighbourhood.json',
  'creek-gauge-data-jalama-flood-peak.json',
] as const;

interface HostedLayerFixture {
  servicePath: string;
  /** Present for layers whose metadata request is answered (the page reads `standardMaxRecordCount`). */
  layerMetadata?: Record<string, unknown>;
  queryResponse: { features: unknown[] } & Record<string, unknown>;
}

export interface HostedServiceReplay {
  /** Replayed requests, as `<kind> <layer path>`. Empty when the page never used the hosted services. */
  served: string[];
  /** Dangermond requests that no fixture answers. */
  unserved: string[];
}

function loadFixtures(): Map<string, HostedLayerFixture> {
  const fixtures = new Map<string, HostedLayerFixture>();
  for (const file of FIXTURE_FILES) {
    const fixture = JSON.parse(readFileSync(path.join(fixtureDirectory, file), 'utf8')) as HostedLayerFixture;
    fixtures.set(fixture.servicePath, fixture);
  }
  return fixtures;
}

function jsonResponse(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json;charset=UTF-8',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}

/**
 * Answers every request to the Dangermond ArcGIS server from the recorded fixtures. Register it after the
 * deterministic-network fixture has run (any test body does): its route is consulted first, and all
 * other external requests still reach the fixture's blocker.
 */
export async function replayHostedObservedGaugeServices(page: Page): Promise<HostedServiceReplay> {
  const fixtures = loadFixtures();
  const replay: HostedServiceReplay = { served: [], unserved: [] };

  await page.route(`${HOSTED_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const resource = url.pathname.startsWith(SERVICES_PREFIX) ? url.pathname.slice(SERVICES_PREFIX.length) : '';
    const isQuery = resource.endsWith('/query');
    const layerPath = isQuery ? resource.slice(0, -'/query'.length) : resource;
    const fixture = fixtures.get(layerPath);

    if (!fixture) {
      replay.unserved.push(`${route.request().method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (isQuery && url.searchParams.get('returnCountOnly') === 'true') {
      replay.served.push(`count ${layerPath}`);
      await route.fulfill(jsonResponse({ count: fixture.queryResponse.features.length }));
    } else if (isQuery) {
      replay.served.push(`rows ${layerPath}`);
      await route.fulfill(jsonResponse(fixture.queryResponse));
    } else if (fixture.layerMetadata) {
      replay.served.push(`layer ${layerPath}`);
      await route.fulfill(jsonResponse(fixture.layerMetadata));
    } else {
      replay.unserved.push(`${route.request().method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
    }
  });

  return replay;
}
