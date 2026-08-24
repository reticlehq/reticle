'use strict';
// withReticle(nextConfig): adds a dev-only webpack pre-loader that stamps data-reticle-source on
// your JSX so @reticlehq/react can report the source file:line — without disabling SWC. It also
// forwards the daemon's auto-provisioned pairing token to the client so a manual reticle.connect()
// can present it (the bridge requires the token even on localhost).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Kept in sync with @reticlehq/core (ReticleDir / ReticleEnv). This package is plain CJS tooling and
// deliberately has no ESM/TS dependency on core, so the two constants are mirrored here.
const PAIRING_TOKEN_DIR_ENV = 'RETICLE_PAIRING_TOKEN_DIR';
const PAIRING_TOKEN_FILE = 'pairing-token';
/** Matches the daemon / Vite plugin token size. */
const TOKEN_BYTES = 32;

/**
 * Read the daemon's auto-provisioned pairing token, or mint one if the file is missing.
 *
 * Same contract as `@reticlehq/vite-plugin`'s `ensurePairingToken`: whichever process starts first
 * (Next config resolve vs daemon) must leave a token the other side will accept. Read-only left a
 * Next app started before the daemon with an empty NEXT_PUBLIC_RETICLE_TOKEN baked in until a full
 * restart after the daemon existed — classic silent non-connect.
 * @returns {string | undefined}
 */
function ensurePairingToken() {
  const override = process.env[PAIRING_TOKEN_DIR_ENV];
  const dir =
    override !== undefined && override.length > 0 ? override : path.join(os.homedir(), '.reticle');
  const filePath = path.join(dir, PAIRING_TOKEN_FILE);
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing or unreadable — fall through and create one */
  }
  try {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    return token;
  } catch {
    return undefined;
  }
}

/** @deprecated Prefer ensurePairingToken — kept as the historical export name for callers/tests. */
function readPairingToken() {
  return ensurePairingToken();
}

/**
 * The stamping loader, addressed by package export so both bundlers can resolve it. Turbopack takes
 * loaders by module id, not by absolute path.
 */
const LOADER_MODULE = '@reticlehq/next/loader';

/**
 * The top-level `turbopack` config key is stable from Next 15.3; before that it was
 * `experimental.turbo`, and an unknown top-level key makes Next print an "Invalid next.config.js
 * options detected" warning on every boot. Older Next also defaults to webpack, so it does not need
 * the key at all — emitting it would be pure noise in somebody's terminal.
 * @returns {boolean}
 */
function supportsTurbopackKey() {
  try {
    const { version } = require('next/package.json');
    const [major, minor] = String(version)
      .split('.')
      .map((n) => parseInt(n, 10));
    if (!Number.isFinite(major)) return true; // unreadable version: assume modern, matching npm's default
    if (major > 15) return true;
    return major === 15 && Number.isFinite(minor) && minor >= 3;
  } catch {
    return true;
  }
}

/**
 * Turbopack rules mirroring the webpack pre-loader.
 *
 * Next 16 made Turbopack the DEFAULT, and a config carrying a `webpack` key with no `turbopack` key
 * is a hard startup error there ("This build is using Turbopack, with a webpack config and no
 * turbopack config") — so `withReticle` killed `next dev` outright for every new Next app. Emitting
 * both keys means whichever bundler is running finds its own wiring and neither errors on the other.
 * @param {Record<string, unknown> | undefined} existing
 */
function turbopackConfig(existing) {
  const rule = { loaders: [LOADER_MODULE] };
  const prev = existing !== undefined && existing !== null ? existing : {};
  const prevRules = prev.rules !== undefined && prev.rules !== null ? prev.rules : {};
  return {
    ...prev,
    rules: {
      ...prevRules,
      // No `as:` — the loader only stamps attributes, so the module type is unchanged. Naming the
      // type here makes Turbopack rewrite the module id (./x.tsx → ./x.tsx.tsx) and every import breaks.
      '*.tsx': rule,
      '*.jsx': rule,
    },
  };
}

/**
 * The React kit the host app imports the SDK from. Deliberately NOT a dependency of this package —
 * it is the user's own install, probed for its version and nothing else. Declaring it here would
 * force the React adapter onto every Next user, including the ones who never import it.
 */
const RETICLE_SDK_PACKAGE = '@reticlehq/react';

/** How far up from the resolved entry to look for the manifest beside it. */
const MANIFEST_SEARCH_DEPTH = 5;

/**
 * Resolve from the APP, not from this file. `next.config.js` is loaded with cwd at the project root,
 * where the user's `@reticlehq/react` always is. A bare `require` resolves relative to THIS package
 * instead, and since the SDK is deliberately not a dependency here, that lookup fails outright under
 * pnpm's strict node_modules layout — silently, into a `catch` that returns ''. Every pnpm Next user
 * therefore reported no `sdkVersion`, which is the one value that turns a skewed pair into a named
 * mismatch rather than a bare -32000.
 * @param {string} specifier
 * @returns {string}
 */
function resolveFromApp(specifier) {
  return require.resolve(specifier, { paths: [process.cwd()] });
}

/**
 * The installed SDK's package version, for the HELLO's `sdkVersion`. Mirrors
 * `@reticlehq/vite-plugin`'s `sdkPackageVersion` — this package is plain CJS tooling with no
 * dependency on the TS packages, so the logic is duplicated rather than imported.
 * @returns {string}
 */
function sdkPackageVersion() {
  // Preferred: the package exports its own manifest. Newer SDKs do.
  try {
    const { version } = require(resolveFromApp(`${RETICLE_SDK_PACKAGE}/package.json`));
    if (typeof version === 'string') return version;
  } catch {
    // Falls through — see below.
  }
  // Fallback, and it is load-bearing rather than defensive: an OLDER SDK has no `./package.json` in
  // its exports map, and an older SDK is precisely the skew this value exists to name.
  try {
    let dir = path.dirname(resolveFromApp(RETICLE_SDK_PACKAGE));
    for (let up = 0; up < MANIFEST_SEARCH_DEPTH; up++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const { version } = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (typeof version === 'string') return version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unresolvable (not installed, exotic layout) — report nothing rather than guessing.
  }
  return '';
}

/**
 * @param {import('next').NextConfig} [nextConfig]
 * @returns {import('next').NextConfig}
 */
function withReticle(nextConfig = {}) {
  // Production builds are untouched — this is a dev-time aid only.
  if (process.env.NODE_ENV === 'production') return nextConfig;

  const userWebpack = nextConfig.webpack;
  const token = ensurePairingToken();
  return {
    ...nextConfig,
    ...(supportsTurbopackKey() ? { turbopack: turbopackConfig(nextConfig.turbopack) } : {}),
    // Expose the token to the client bundle as process.env.NEXT_PUBLIC_RETICLE_TOKEN (Next's convention
    // for client-readable env), so a dev-only client connect can present it. Omitted when the daemon
    // hasn't provisioned one yet — the client then connects without it and the page reloads once it has.
    env: {
      ...nextConfig.env,
      ...(token !== undefined ? { NEXT_PUBLIC_RETICLE_TOKEN: token } : {}),
      // The project root, so the SDK can report React's absolute `_debugSource.fileName` as a
      // repo-relative path. Passed via `env` rather than a webpack DefinePlugin because Turbopack — the
      // Next 16 default — never runs the webpack branch, and a source pointer that only works on one
      // of the two bundlers is worse than one that works on neither.
      NEXT_PUBLIC_RETICLE_ROOT: process.cwd(),
      // So a version-skewed pair can name itself instead of surfacing as a bare -32000.
      NEXT_PUBLIC_RETICLE_SDK_VERSION: sdkPackageVersion(),
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

module.exports = { withReticle, readPairingToken, ensurePairingToken };
