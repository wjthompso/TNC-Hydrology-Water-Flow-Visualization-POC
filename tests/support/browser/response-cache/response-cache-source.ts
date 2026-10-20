/** One live service whose responses the response cache saves and replays. */
export interface ResponseCacheSource {
  /** Human-readable source name for comments and diagnostics. */
  name: string;
  /** Versioned on-disk folder for this source's entries. */
  directory: () => string;
  /** Whether a browser request belongs to this source. `pageOrigin` is the test page server. */
  matches: (url: URL, pageOrigin: string | undefined) => boolean;
  /** The URL that identifies the response. It is hashed into the cache key and stored redacted. */
  keyUrl: (url: URL) => string;
  /**
   * Whether a live response may be saved. HTTP 429 and 5xx are never saved, so a
   * rate-limited or failing run cannot poison later runs.
   */
  isSavable: (status: number, contentType: string | null, body: Buffer) => boolean;
}
