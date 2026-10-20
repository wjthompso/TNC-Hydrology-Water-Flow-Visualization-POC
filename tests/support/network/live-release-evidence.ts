import type { LiveNetworkSummary } from './live-network-telemetry';

const ABORTED_REQUEST = /ERR_ABORTED|\baborted\b/i;
const TRANSPORT_FAILURE =
  /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_CERT|ERR_SSL|ERR_TLS|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_TUNNEL|ERR_PROXY|ERR_EMPTY_RESPONSE|ERR_SSL_PROTOCOL|NS_ERROR_NET|ECONNRESET|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|certificate|tls handshake/i;
const GRAPHICS_FAILURE = /webgl|gpu|context lost|graphics device|swiftshader/i;

export function approvedExternalDisruptionEvidence(input: {
  message: string;
  pageErrors: readonly string[];
  network: LiveNetworkSummary;
}): string | null {
  if (input.network.rateLimitedResponses > 0) {
    return `HTTP 429 responses: ${input.network.rateLimitedResponses}`;
  }
  if (input.network.serverErrorResponses > 0) {
    return `HTTP 5xx responses: ${input.network.serverErrorResponses}`;
  }

  const transportFailure = input.network.failedRequests.find(
    (request) => !ABORTED_REQUEST.test(request.failure) && TRANSPORT_FAILURE.test(request.failure),
  );
  if (transportFailure) {
    return `${transportFailure.endpoint} ${transportFailure.failure}`;
  }

  const text = [input.message, ...input.pageErrors].join('\n');
  if (GRAPHICS_FAILURE.test(text)) return 'graphics-environment failure';
  if (TRANSPORT_FAILURE.test(text)) return 'network, DNS, or TLS failure';
  if (/\b429\b/.test(text)) return 'HTTP 429';
  if (/\b5\d{2}\b/.test(text) && /http|status|service unavailable|bad gateway|gateway timeout/i.test(text)) {
    return 'HTTP 5xx';
  }
  return null;
}
