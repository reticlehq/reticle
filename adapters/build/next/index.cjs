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
// deliberately has no ESM/TS dependency on core, so these values are mirrored here.
const PAIRING_TOKEN_DIR_ENV = 'RETICLE_PAIRING_TOKEN_DIR';
const STATE_DIR_ENV = 'RETICLE_STATE_DIR';
const PORT_ENV = 'RETICLE_PORT';
/**
 * Instrument anyway, whatever NODE_ENV says — for `NODE_ENV=production next dev`.
 *
 * Named here rather than imported: this package is plain CJS tooling that deliberately depends on
 * nothing, which is why `RETICLE_PAIRING_TOKEN_DIR` above is a local constant too.
 */
const DEV_OVERRIDE_ENV = 'RETICLE_DEV';
/** Next's own marker on the server process `next dev` forks. See the production gate below. */
const NEXT_DEV_WORKER_ENV = 'NEXT_PRIVATE_WORKER';
const PAIRING_TOKEN_FILE = 'pairing-token';
const RETICLE_CONFIG_FILE = '.reticle.json';
const RETICLE_HOME_DIR = '.reticle';
// Mirrors core's daemonRegistryFileName: ~/.reticle/daemon-<port>.json.
const DAEMON_ENTRY_PREFIX = 'daemon-';
const DAEMON_ENTRY_SUFFIX = '.json';
// Mirrors core's RETICLE_CLIENT_HOST / RETICLE_WS_PATH. This package is plain CJS tooling with no
// ESM/TS dependency on core, so the values are duplicated here the way the constants above are — and
// pinned to core's by test, because a URL that drifts produces a silent no-connect rather than an
// error anybody sees.
const RETICLE_CLIENT_HOST = 'localhost';
const RETICLE_WS_PATH = '/reticle';

/**
 * Read the pairing token, or create it — whichever process gets there first.
 *
 * Read once at `next.config` evaluation is NOT enough: start `next dev` before the daemon and the
 * value is empty, every page is refused, and a reload cannot help because there is no token
 * page-side to pick up.
 *
 * Same mint as the daemon (24 random bytes, 0600 file, never overwrite). An existing token is
 * reused so a plugin-injected page keeps working after the daemon bounces.
 * @param {string} dir
 * @returns {string | undefined}
 */
function ensurePairingToken(dir) {
  const file = path.join(dir, PAIRING_TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing or unreadable — fall through and create one */
  }
  try {
    const token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Read or mint the daemon's auto-provisioned pairing token (~/.reticle/pairing-token, or the
 * RETICLE_PAIRING_TOKEN_DIR override). Node-side only. Minting here is what makes `next dev` before
 * the daemon still authenticate.
 * @returns {string | undefined}
 */
function readPairingToken() {
  return ensurePairingToken(reticleHomeDir());
}

/**
 * Find the live daemon serving THIS project and return its websocket URL.
 *
 * The Vite plugin has always done this (`discoverDaemonPort`), and core's `pickDaemonPort` documents
 * the rule as shared by "both the vite and next plugins" — but this package never implemented the
 * next half. The consequence was a frozen port: `reticle init` baked `url: 'ws://localhost:<port>'`
 * into the generated ReticleDev component at install time, and the app dialled that forever. Move the
 * daemon and a Next app silently dials a port nothing is listening on, with no error anywhere except
 * a console warning in a browser nobody is watching.
 *
 * The rule is core's, mirrored rather than imported for the same reason the constants above are: this
 * package is plain CJS tooling with no ESM/TS dependency on core. Kept deliberately identical:
 *   1. the port in `.reticle.json` wins whenever a live daemon not serving ANOTHER project is
 *      registered on it — `init --port`
 *      used to leave the old daemon alive, and discovery took the lower port and dialled it;
 *   2. drop dead daemons (crashed, or a stale entry left by a kill -9);
 *   3. among the living, prefer a projectId match, lowest port on a tie;
 *   4. return undefined when nothing matches, so the app falls back to the default port rather than
 *      auto-connecting to a daemon serving a DIFFERENT project — a wrong connect is worse than an
 *      honest default, because it reports another app's state as this one's.
 *
 * The projectId is READ from `.reticle.json` rather than re-derived. Re-deriving would duplicate
 * core's slug + hash rule in a third place, and a drift there does not fail loudly: it silently
 * matches no daemon, which is the exact bug this function exists to remove.
 * @returns {string | undefined}
 */
/** Pairing token and registry locations have separate overrides, matching the daemon. */
function reticleHomeDir(envKey = PAIRING_TOKEN_DIR_ENV) {
  const override = process.env[envKey];
  return override !== undefined && override.length > 0
    ? override
    : path.join(os.homedir(), RETICLE_HOME_DIR);
}

/** process.kill(pid, 0) throws iff the process is gone: the same liveness probe the daemon uses. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MAX_TCP_PORT = 65535;

/** @param {number} port */
const bridgeUrl = (port) => `ws://${RETICLE_CLIENT_HOST}:${String(port)}${RETICLE_WS_PATH}`;

/**
 * RETICLE_PORT overrides discovery. Otherwise, follow the Vite plugin's order: a live daemon for this
 * project, then the `port` in `.reticle.json`, and only then the `url` literal `reticle init` wrote
 * into the generated ReticleDev component (which this value overrides page-side). The file comes
 * before the literal because it is what the daemon and the CLI read: a user who edited it moved the
 * daemon, and the page kept dialling the old literal with nothing saying why.
 */
function discoverDaemonUrl(
  cwd = process.cwd(),
  home = reticleHomeDir(STATE_DIR_ENV),
  alive = defaultIsAlive,
  env = process.env,
) {
  const requested = env[PORT_ENV];
  if (requested !== undefined && /^\d+$/.test(requested)) {
    const port = Number(requested);
    if (Number.isInteger(port) && port > 0 && port <= MAX_TCP_PORT) return bridgeUrl(port);
  }
  let projectId;
  let configuredPort;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, RETICLE_CONFIG_FILE), 'utf8'));
    projectId = typeof parsed?.projectId === 'string' ? parsed.projectId : undefined;
    const port = parsed?.port;
    configuredPort = Number.isInteger(port) && port > 0 && port <= MAX_TCP_PORT ? port : undefined;
  } catch {
    return undefined; // no .reticle.json: this project has not been through `reticle init`
  }
  const discovered = discoverRegisteredPort(projectId, home, alive, configuredPort);
  const port = discovered ?? configuredPort;
  return port === undefined ? undefined : bridgeUrl(port);
}

/**
 * The live daemon registered in `home` for `projectId`, lowest port on a tie — or the configured port,
 * when a live daemon registered there is not another project's (core's `pickDaemonPort`, rule 1).
 * @param {string | undefined} projectId
 * @param {string} dir
 * @param {(pid: number) => boolean} alive
 * @param {number | undefined} configuredPort
 * @returns {number | undefined}
 */
function discoverRegisteredPort(projectId, dir, alive, configuredPort) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return undefined; // no ~/.reticle yet: no daemon has ever run here
  }
  const ports = [];
  for (const file of files) {
    if (!file.startsWith(DAEMON_ENTRY_PREFIX) || !file.endsWith(DAEMON_ENTRY_SUFFIX)) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // a half-written or corrupt entry is not a daemon
    }
    if (typeof entry?.port !== 'number' || typeof entry.pid !== 'number') continue;
    if (!alive(entry.pid)) continue;
    const mine = entry.projectId === projectId;
    const unnamed = entry.projectId === undefined || projectId === undefined;
    if (entry.port === configuredPort && (mine || unnamed)) return configuredPort;
    if (projectId === undefined || projectId.length === 0 || !mine) continue;
    ports.push(entry.port);
  }
  return ports.length === 0 ? undefined : Math.min(...ports);
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
    // From the APP, for the reason `resolveFromApp` records below: a bare require resolves against
    // THIS package, so the version read could be some other copy of Next than the one about to run.
    // Reading an older one returns false, no `turbopack` key is emitted, and on Next 16 — where
    // Turbopack is the default — a config with a `webpack` key and no `turbopack` key is a hard
    // `next dev` startup error. That is the failure the key exists to prevent.
    const { version } = require(resolveFromApp('next/package.json'));
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
      // A JavaScript Next project's pages are .js (#1081). `.js` also names every file in
      // node_modules, so the rule is limited to the project's own code; `condition` is Next 16+,
      // and an older Turbopack that does not know the key is left without the rule rather than
      // handed one it would reject.
      ...(supportsRuleConditions() ? { '*.js': { ...rule, condition: { not: 'foreign' } } } : {}),
    },
  };
}

/**
 * The loopback hosts a Reticle-opened tab may arrive on, in the form Next compares: the Origin's
 * `hostname`, which keeps the brackets on IPv6. `localhost` is not listed because Next always
 * allows it.
 */
const LOOPBACK_DEV_ORIGINS = ['127.0.0.1', '[::1]'];

/**
 * Whether this Next release accepts `allowedDevOrigins`. It arrived in 15.2.2 and was backported to
 * 14.2.30; on anything older it is an unknown key, which Next reports as "Invalid next.config.js
 * options detected" on every boot. An unreadable version is assumed modern, as elsewhere here.
 * @param {string | undefined} version
 * @returns {boolean}
 */
function knowsAllowedDevOrigins(version) {
  const [major, minor, patch] = String(version)
    .split('.')
    .map((n) => parseInt(n, 10));
  if (!Number.isFinite(major)) return true;
  const at = (m, p) => minor > m || (minor === m && patch >= p);
  if (major > 15) return true;
  if (major === 15) return at(2, 2);
  if (major === 14) return at(2, 30);
  return false;
}

/** The installed Next's version, read from the APP (see resolveFromApp), or undefined. */
function installedNextVersion() {
  try {
    return String(require(resolveFromApp('next/package.json')).version);
  } catch {
    return undefined;
  }
}

/**
 * The app's `allowedDevOrigins` plus the loopback hosts, or undefined when this Next does not know
 * the key.
 *
 * Next 16 BLOCKS its dev resources (`/_next/*`, HMR) for an origin outside this list, and only
 * `localhost` is allowed by default. A tab opened on 127.0.0.1 or [::1] — which is where a first
 * run lands when `localhost` answers slowly on a cold compile — got the HTML and nothing else: no
 * hydration, so the connect effect never ran and the SDK "never dialled the bridge".
 * @param {string[] | undefined} existing
 * @returns {string[] | undefined}
 */
function devOrigins(existing) {
  if (!knowsAllowedDevOrigins(installedNextVersion())) return undefined;
  const mine = Array.isArray(existing) ? existing : [];
  return [...mine, ...LOOPBACK_DEV_ORIGINS.filter((host) => !mine.includes(host))];
}

/** Whether this Next's Turbopack accepts a rule `condition` (added with Next 16). */
function supportsRuleConditions() {
  try {
    const { version } = require(resolveFromApp('next/package.json'));
    const major = parseInt(String(version).split('.')[0] ?? '', 10);
    return !Number.isFinite(major) || major >= 16;
  } catch {
    return true;
  }
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
 * @param {{ sourceMapping?: boolean }} [options] Pass `{ sourceMapping: false }` for an app that
 *   renders through a non-DOM React reconciler — react-three-fiber, react-pdf, ink. A lowercase JSX
 *   tag is a host element in every React renderer, but only React DOM's host instances are nodes
 *   that take attributes. R3F reads the dashed `data-reticle-source` as a pierced property path,
 *   walks `data` -> `reticle` on a three.js instance that has no `data`, and throws from the commit
 *   phase — unmounting the whole tree to a white screen. The babel plugin's allowlist keeps the
 *   stamp off `<mesh>`, and cannot help with the tags that COLLIDE: `<line>` is SVG's AND
 *   `THREE.Line`; `<audio>` is both. Turning the stamp off costs source pointers, not the app.
 * @returns {import('next').NextConfig}
 */
function withReticle(nextConfig = {}, options = {}) {
  /*
   * Production builds are untouched — this is a dev-time aid only.
   *
   * NODE_ENV is the gate because it is the only signal available where this runs. `withReticle`
   * receives no `phase`, and Next evaluates the config inside `start-server.js`, a child process
   * whose argv carries no `dev` — MEASURED, after a first attempt read argv and was wrong on a real
   * `next dev`. The webpack hook below does get Next's own `dev` flag, but the pairing token is
   * injected at CONFIG level, and baking one into a production bundle is the thing this gate exists
   * to prevent.
   *
   * What was actually broken is that it happened in SILENCE. `NODE_ENV=production next dev` is a
   * real configuration — people use it to reproduce production behaviour locally — and the result
   * was an app that looked instrumented, started cleanly and never connected, with no reason to
   * suspect an env var set for something else. So it says why, once, and names both the variable
   * responsible and the way out (#1069).
   */
  if (process.env.NODE_ENV === 'production' && process.env[DEV_OVERRIDE_ENV] !== '1') {
    // Only on a dev server, where being off is the surprise. `next build` and `next typegen`
    // evaluate this config under NODE_ENV=production too, and there off is simply correct: the
    // line read as a fault in every build log. NEXT_PRIVATE_WORKER is set by `next dev` on the
    // server process it forks (Next 13 through 16) and by no other command.
    if (process.env[NEXT_DEV_WORKER_ENV] === '1') {
      console.log(
        `[reticle] instrumentation is OFF because NODE_ENV=production. ` +
          `If this is a dev server you want instrumented, set ${DEV_OVERRIDE_ENV}=1 (or do not export ` +
          `NODE_ENV=production for it) — nothing else about your config needs to change.`,
      );
    }
    return nextConfig;
  }

  const userWebpack = nextConfig.webpack;
  const token = readPairingToken();
  const daemonUrl = discoverDaemonUrl();
  const allowedDevOrigins = devOrigins(nextConfig.allowedDevOrigins);
  return {
    ...nextConfig,
    ...(allowedDevOrigins !== undefined ? { allowedDevOrigins } : {}),
    ...(supportsTurbopackKey()
      ? {
          turbopack:
            options.sourceMapping !== false
              ? turbopackConfig(nextConfig.turbopack)
              : (nextConfig.turbopack ?? {}),
        }
      : {}),
    // Expose the token to the client bundle as process.env.NEXT_PUBLIC_RETICLE_TOKEN (Next's convention
    // for client-readable env), so a dev-only client connect can present it. Minted here if the file
    // is missing: Next evaluates this once, so an empty value is frozen and a reload cannot pick a
    // later token up. Omitted only when the directory is unwritable.
    env: {
      ...nextConfig.env,
      ...(token !== undefined ? { NEXT_PUBLIC_RETICLE_TOKEN: token } : {}),
      // The project root, so the SDK can report React's absolute `_debugSource.fileName` as a
      // repo-relative path. Passed via `env` rather than a webpack DefinePlugin because Turbopack — the
      // Next 16 default — never runs the webpack branch, and a source pointer that only works on one
      // of the two bundlers is worse than one that works on neither.
      NEXT_PUBLIC_RETICLE_ROOT: process.cwd(),
      // The daemon serving THIS project, discovered on every dev-server start rather than baked in
      // at install time. Without it the generated connect keeps whatever port `init` happened to see,
      // and a daemon that later moves is unreachable with no error the user ever sees.
      ...(daemonUrl !== undefined ? { NEXT_PUBLIC_RETICLE_URL: daemonUrl } : {}),
      // So a version-skewed pair can name itself instead of surfacing as a bare -32000.
      NEXT_PUBLIC_RETICLE_SDK_VERSION: sdkPackageVersion(),
    },
    webpack(config, ctx) {
      if (options.sourceMapping !== false) {
        config.module = config.module || { rules: [] };
        config.module.rules = config.module.rules || [];
        config.module.rules.push({
          // .js as well: see the Turbopack rule above (#1081).
          test: /\.(tsx|jsx|js)$/,
          exclude: /node_modules/,
          enforce: 'pre',
          use: [{ loader: require.resolve('./loader.cjs') }],
        });
      }
      return typeof userWebpack === 'function' ? userWebpack(config, ctx) : config;
    },
  };
}

module.exports = { withReticle, readPairingToken, discoverDaemonUrl, knowsAllowedDevOrigins };
