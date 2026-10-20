import type { Page, Request, Response } from '@playwright/test';

export interface LiveNetworkSummary {
  requestCount: number;
  failedRequests: Array<{ endpoint: string; failure: string }>;
  rateLimitedResponses: number;
  serverErrorResponses: number;
  slowestEndpoints: Array<{ endpoint: string; latencyMs: number }>;
}

function redactUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}

export function observeLiveNetwork(page: Page): () => LiveNetworkSummary {
  const startedAt = new Map<Request, number>();
  const latencies: Array<{ endpoint: string; latencyMs: number }> = [];
  const failedRequests: LiveNetworkSummary['failedRequests'] = [];
  let requestCount = 0;
  let rateLimitedResponses = 0;
  let serverErrorResponses = 0;

  page.on('request', (request) => {
    requestCount += 1;
    startedAt.set(request, performance.now());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({
      endpoint: redactUrl(request.url()),
      failure: request.failure()?.errorText ?? 'unknown request failure',
    });
  });
  page.on('response', (response: Response) => {
    const request = response.request();
    const start = startedAt.get(request);
    if (start !== undefined) {
      latencies.push({
        endpoint: redactUrl(response.url()),
        latencyMs: Math.round(performance.now() - start),
      });
    }
    if (response.status() === 429) rateLimitedResponses += 1;
    if (response.status() >= 500) serverErrorResponses += 1;
  });

  return () => ({
    requestCount,
    failedRequests,
    rateLimitedResponses,
    serverErrorResponses,
    slowestEndpoints: latencies
      .sort((a, b) => b.latencyMs - a.latencyMs)
      .slice(0, 5),
  });
}
