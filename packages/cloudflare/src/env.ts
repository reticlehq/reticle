export interface Env {
  BROWSER: Fetcher;
  ARTIFACTS: R2Bucket;
  VERIFICATION_RUNNER: DurableObjectNamespace;
  /** Set with `wrangler secret put RETICLE_CLOUD_KEY`; never commit it as a plain-text var. */
  RETICLE_CLOUD_KEY?: string;
  /** Optional comma-separated preview-host allowlist (exact hosts or `.example.com` suffixes). */
  RETICLE_ALLOWED_HOSTS?: string;
  RETICLE_PROJECT_ID?: string;
  RETICLE_PROJECT_NAME?: string;
}
