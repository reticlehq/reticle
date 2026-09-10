/** Wrap a Next.js config to add dev-only source-file mapping (data-reticle-source), keeping SWC. */
export function withReticle<T = unknown>(
  nextConfig?: T,
  options?: {
    /**
     * Stamp `data-reticle-source` on JSX host elements. Default true. Set false for an app that
     * renders through a non-DOM React reconciler (react-three-fiber, react-pdf, ink), where a
     * lowercase tag is not an element and the stamp crashes the app at commit time.
     */
    sourceMapping?: boolean;
  },
): T;
