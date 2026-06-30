// '@reticle/core/next' → the Next.js dev-only source-mapping wrapper.
//
// This is a SELF-CONTAINED ESM implementation (not a re-export of the CJS @reticle/next package),
// because the umbrella publishes ESM under "type":"module". The webpack pre-loader must live as a real
// file on disk (webpack requires it in a worker), so it ships as dist/loader.cjs and we resolve its
// path via import.meta.url — NOT require.resolve, which is undefined when Next loads next.config.ts as
// ESM (the bug that crashed the bundled build with `__require.resolve is not a function`).

import { fileURLToPath } from 'node:url';

/** Absolute path to the shipped loader, resolved relative to THIS file (dist/next.js → dist/loader.cjs). */
const LOADER_PATH = fileURLToPath(new URL('./loader.cjs', import.meta.url));

/** A minimal mutable webpack config shape — avoids a hard dependency on `webpack`/`next` types. */
interface WebpackConfigLike {
  module?: { rules?: unknown[] };
}

/** Minimal Next config shape — only the field we touch is typed; the rest passes through. */
interface NextConfigLike {
  webpack?: (config: WebpackConfigLike, ctx: unknown) => WebpackConfigLike;
  [key: string]: unknown;
}

/**
 * Wrap your Next config to stamp `data-reticle-source` on JSX in dev (so reticle_inspect maps DOM → file:line)
 * without disabling SWC. Production builds are untouched. Usage:
 *
 *   import { withReticle } from '@reticle/core/next';
 *   export default withReticle(nextConfig);
 */
export function withReticle(nextConfig: NextConfigLike = {}): NextConfigLike {
  // Dev-time aid only — never alter production builds.
  if (process.env['NODE_ENV'] === 'production') return nextConfig;

  const userWebpack = nextConfig.webpack;
  return {
    ...nextConfig,
    webpack(config: WebpackConfigLike, ctx: unknown): WebpackConfigLike {
      const mod = (config.module ??= {});
      const rules = (mod.rules ??= []);
      rules.push({
        test: /\.(t|j)sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: LOADER_PATH }],
      });
      return typeof userWebpack === 'function' ? userWebpack(config, ctx) : config;
    },
  };
}
