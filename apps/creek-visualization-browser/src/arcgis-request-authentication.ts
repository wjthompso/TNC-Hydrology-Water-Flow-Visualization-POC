// ArcGIS request authentication for the hosted modeled data (UCS-285).
//
// The published feature services on the Dangermond Preserve ArcGIS Enterprise
// portal are private for now. Their requests go through `esriRequest`; when the
// server answers 499/401 ("token required"), the SDK's IdentityManager shows
// its built-in sign-in dialog for the portal that owns the server. Once the
// items are shared with the organization or the public, no code change is
// needed: the dialog simply never appears.
//
// The Esri developer API key (`VITE_ARCGIS_API_KEY`, for Esri basemaps and
// World Elevation) must never reach the Enterprise host: an API key sent to
// ArcGIS Enterprise can be rejected with 498 (invalid token). In
// @arcgis/core 4.34 the global `esriConfig.apiKey` is only attached to
// `*.arcgis.com` URLs; the `before` interceptor below is a defensive second
// guard that strips the key if anything ever attaches it to the portal host.

let configured: Promise<void> | null = null;

export interface ArcgisRequestAuthenticationOptions {
  /** e.g. https://dangermondpreserve-spatial.com/portal */
  readonly arcgisPortalUrl: string;
}

/** Idempotent: the first call configures the SDK; later calls wait for it. */
export function configureArcgisRequestAuthentication(options: ArcgisRequestAuthenticationOptions): Promise<void> {
  configured ??= configure(options);
  return configured;
}

async function configure(options: ArcgisRequestAuthenticationOptions): Promise<void> {
  const [{ default: esriConfig }] = await Promise.all([
    import('@arcgis/core/config.js'),
    // Importing the IdentityManager registers it, so `esriRequest` can prompt for sign-in.
    import('@arcgis/core/identity/IdentityManager.js'),
  ]);

  esriConfig.portalUrl = options.arcgisPortalUrl;

  const enterpriseOrigin = new URL(options.arcgisPortalUrl).origin;
  esriConfig.request.interceptors?.push({
    urls: enterpriseOrigin,
    before(parameters) {
      const apiKey = esriConfig.apiKey;
      const query = parameters.requestOptions?.query as Record<string, unknown> | undefined;
      if (apiKey && query && query.token === apiKey) delete query.token;
    },
  });
}
