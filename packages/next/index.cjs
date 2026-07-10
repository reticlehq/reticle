'use strict';
// withReticle(nextConfig): adds a dev-only webpack pre-loader that stamps data-reticle-source on
// your JSX so @reticlehq/react can report the source file:line — without disabling SWC. It also
// forwards the daemon's auto-provisioned pairing token to the client so a manual reticle.connect()
// can present it (the bridge requires the token even on localhost).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Kept in sync with @reticlehq/core (ReticleDir / ReticleEnv). This package is plain CJS tooling and
// deliberately has no ESM/TS dependency on core, so the two constants are mirrored here.
const PAIRING_TOKEN_DIR_ENV = 'RETICLE_PAIRING_TOKEN_DIR';
const PAIRING_TOKEN_FILE = 'pairing-token';

/**
 * Read the daemon's auto-provisioned pairing token (~/.reticle/pairing-token, or the
 * RETICLE_PAIRING_TOKEN_DIR override). Node-side only. Returns undefined if the daemon hasn't started
 * yet (start it before `next dev`); the client then connects without a token and the page reloads once
 * the daemon is up and the config is re-read.
 * @returns {string | undefined}
 */
function readPairingToken() {
  const override = process.env[PAIRING_TOKEN_DIR_ENV];
  const dir =
    override !== undefined && override.length > 0 ? override : path.join(os.homedir(), '.reticle');
  try {
    const token = fs.readFileSync(path.join(dir, PAIRING_TOKEN_FILE), 'utf8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {import('next').NextConfig} [nextConfig]
 * @returns {import('next').NextConfig}
 */
function withReticle(nextConfig = {}) {
  // Production builds are untouched — this is a dev-time aid only.
  if (process.env.NODE_ENV === 'production') return nextConfig;

  const userWebpack = nextConfig.webpack;
  const token = readPairingToken();
  return {
    ...nextConfig,
    // Expose the token to the client bundle as process.env.NEXT_PUBLIC_RETICLE_TOKEN (Next's convention
    // for client-readable env), so a dev-only client connect can present it. Omitted when the daemon
    // hasn't provisioned one yet — the client then connects without it and the page reloads once it has.
    env: {
      ...nextConfig.env,
      ...(token !== undefined ? { NEXT_PUBLIC_RETICLE_TOKEN: token } : {}),
    },
    webpack(config, ctx) {
      config.module = config.module || { rules: [] };
      config.module.rules = config.module.rules || [];
      config.module.rules.push({
        test: /\.(t|j)sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: require.resolve('./loader.cjs') }],
      });
      return typeof userWebpack === 'function' ? userWebpack(config, ctx) : config;
    },
  };
}

module.exports = { withReticle, readPairingToken };
