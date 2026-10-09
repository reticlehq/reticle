// Tier 1: install Reticle into apps that have never seen it, and check a session actually appears
// AND answers true/false assertions and an action over MCP. A HELLO is not a working install.
//
// Every gate in this repo is blind to the install. `apps/bench-app`, `apps/next-smoke` and the rest
// are ALREADY instrumented, so re-running `init` over one reports `·` (already wired) for every step
// and proves nothing — which is exactly how a Next.js install shipped connecting 0% of the time
// through three independent defects, none of which any check short of opening a browser could see.
//
// The pristine surface is SCAFFOLDED rather than vendored. `npm create vite` and `create-next-app`
// produce apps that have never seen Reticle, in seconds, with nothing to store or maintain. That
// catches install REGRESSIONS. It does not catch install COMPLEXITY — a 70-dependency app with ten
// Vite plugins is a different question, and it belongs in the reticle-fixtures gate (Tier 2), which
// is slower and cannot block a PR. Conflating the two gives a gate too slow to block and too shallow
// to trust.
//
// Five scaffolds, because `init` has five genuinely different paths into an app. Vite Vue is the
// non-React kit path. Pages Router has no `app/` root layout to patch, so connect has to mount
// through `pages/_app` — and that is the path that once did nothing at all, silently.
//
// `monorepo-subdir` is a different axis: the other four are all the same SHAPE — a single-app root
// with `init` run inside it — and that sameness is what made this gate blind to four init defects one
// user hit in eight minutes.
//
//   pnpm gate:install                 # all scaffolds
//   node apps/e2e/install-gate.mjs --only next-pages-router [--keep]
//   pnpm gate:install:self-test       # negative control: every scaffold must go RED
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { evaluateInstallControl, SESSION_CHECK, sessionMatchesPage } from './install-control.mjs';
import { requireAssertion, requireVerdict } from './smoke-checks.mjs';
import { restoreInstallPackages } from './install-packages.mjs';

// ── Never phone home from the gate ───────────────────────────────────────────────────────────────
//
// Set BEFORE anything spawns, and on this process rather than per-call, so every child inherits it —
// the `reticle init` runs, the dev servers, and the daemon whichever of them starts it. Per-spawn
// env is how the next site added here quietly leaks.
//
// This is the ONE harness the source-checkout guard does not cover. That guard walks up from `cwd`
// looking for the monorepo's package.json, and this gate deliberately scaffolds PRISTINE apps into
// the OS temp directory and installs Reticle into them from a local Verdaccio — which is the entire
// point of it, and which means those daemons are, correctly, not in a source checkout.
//
// So it emitted real events. Measured in one day of production data: 308 CI rows from 19 distinct
// anonymous ids — every runner a brand-new "user" — carrying 144 of the 169 `init_completed` events
// and 19 `reticle_installed`. The gate was the majority of our own install funnel, and on a release
// branch it reports that branch's version, so unreleased versions appear in production dashboards.
//
// `RETICLE_TELEMETRY=0` and not `RETICLE_TELEMETRY_FILE`: the gate asserts on `init`'s printed plan,
// never on emitted events, so there is nothing here worth recording.
process.env.RETICLE_TELEMETRY = '0';

// ── And say what we are, whoever is running us ──────────────────────────────────────────────────
//
// `CI` is how every event decides whether it came from a pipeline, and it is only ever set by the
// runner. A gate driven from a laptop or from a cloud agent sandbox therefore reports itself as a
// human at a machine — which is how our own gate traffic became indistinguishable from a user's in
// the one dataset that decides what gets built. Set here rather than relied on from the environment,
// so the claim is true regardless of who invoked this.
//
// The telemetry line above already silences the events; this is belt and braces for anything that
// re-enables them (a debug run recording to a local sink) and for the CLI's own CI-shaped defaults.
process.env.CI = process.env.CI ?? 'true';
// Corepack, silenced before it can ask a question nobody is there to answer.
//
// If any scaffold's manifest carries a `packageManager` field — `create-next-app` has shipped one
// in the past and may again — corepack intercepts every `npm`/`pnpm` call and, for a version it
// does not have cached, prints a y/N download prompt and WAITS. Nothing is attached to that stdin,
// so the gate does not fail: it hangs until the job's timeout, and a timeout says "the install
// takes too long on Windows" rather than "a prompt is waiting". Two variables turn a hang into
// either a normal install or a named error.
process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
process.env.COREPACK_ENABLE_STRICT = process.env.COREPACK_ENABLE_STRICT ?? '0';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  freePortSafely,
  portHolders,
  killTree,
  stopProcessTree,
  startOwnedDaemon,
  watchTransport,
  attributeOutcome,
  Attribution,
  sweepBatteryOrphans,
} from './gate-harness.mjs';
// Batteries are not watched, and a shown browser changes their timing: hide every browser Reticle opens.
process.env.RETICLE_HEADLESS ??= '1';

const WIN = 'win32' === process.platform;

/**
 * `npm`, `npx` and `pnpm` are `.cmd` shims on Windows, and Node will not run one for you.
 *
 * Two separate obstacles, and clearing only the first is what made the first Windows run of this
 * gate die on `spawn EINVAL` at the very first command:
 *
 *  1. CreateProcess does not consult PATHEXT, so `spawn('npm', …)` is ENOENT even though npm plainly
 *     works in that shell. The file wanted is `npm.cmd`.
 *  2. Node then REFUSES to spawn a `.cmd` or `.bat` without `shell: true` — the fix for
 *     CVE-2024-27980, where batch files re-parse their own arguments. That refusal is `EINVAL`,
 *     which names neither the file nor the reason.
 *
 * So the shell is not optional here, and the argument-reinterpretation worry that argued against it
 * does not apply to the shell we actually get: `cmd.exe` does not glob, so the `*` in an import
 * alias survives, and `@` and `--` are ordinary characters to it. What cmd.exe DOES need is quoting
 * around whitespace, because Node joins the arguments into one string before handing them over —
 * and a temp directory with a space in it is the normal case on a real user's machine, as opposed
 * to the 8.3 short path a CI runner happens to hand out.
 */
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
const quoteForCmd = (arg) =>
  /[\s"]/.test(arg) ? `"${String(arg).split('"').join('\\"')}"` : String(arg);

/** A command and the options it must be spawned with, on either kind of machine. */
function pm(cmd, args = []) {
  if (!WIN || !PACKAGE_MANAGERS.has(cmd)) return { cmd, args, shellOpts: {} };
  return { cmd: `${cmd}.cmd`, args: args.map(quoteForCmd), shellOpts: { shell: true } };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'server/dist/command/cli.js');
// All records here belong to this invocation, including servers handed over by init.
const GATE_STATE_DIR = mkdtempSync(join(tmpdir(), 'reticle-install-state-'));
process.env.RETICLE_STATE_DIR = GATE_STATE_DIR;
process.env.RETICLE_PAIRING_TOKEN_DIR = GATE_STATE_DIR;

const PACKAGE_DIRECTORY = process.env.INSTALL_GATE_PACKAGES;
// Validation/restoration precedes any live registry, so a corrupt artifact cannot be tested.
const PREBUILT_PACKAGES = PACKAGE_DIRECTORY === undefined ? undefined : restoreInstallPackages(PACKAGE_DIRECTORY, ROOT);
/** Separate ranges keep a control's teardown out of the positive run. */
const SELF_TEST_PORT_OFFSET = 60;
const BRIDGE_PORT_BASE = Number(process.env.INSTALL_GATE_PORT ?? '4788');
/**
 * How long init's handed-over dev server gets to answer once init has exited. Short, because init
 * only reports success after a session connected through that very server: it was answering a
 * moment ago, and a bound here is a bound, not a measurement of how fast a server boots.
 */
const HANDOVER_ANSWER_MS = 15_000;
/**
 * How long to wait for the dev server to WRITE something after the gate edits a source file. The
 * write is the point: a server whose output went to a pipe nobody reads dies on it. A bound, not a
 * timing assertion — the check that follows asks whether the server still answers.
 */
const EDIT_LOG_WAIT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 45_000;
/** After a session appears, how long to wait for `hasCapabilities` to flip true on reannounce. */
const CAPABILITIES_WAIT_MS = 10_000;
const KEEP = process.argv.includes('--keep');
/**
 * A `data-testid` the gate plants in every scaffold so `init` has something to register.
 *
 * Empty create-vite / create-next-app apps have none, so `init` writes
 * `registerCapabilities({ testids: [], signals: [], stores: [] })` and `hasCapabilities` stays
 * false. Requiring verifiability without this stamp would paint every scaffold red for a reason
 * that is true of an empty app and uninformative. With it, a regression that writes empty arrays
 * again fails the session check below.
 */
const INSTALL_PROBE_TESTID = 'reticle-install-probe';
const INSTALL_PROBE_FILE = 'reticle-install-probe.ts';
/** Block the real SDK socket and require exactly the session check to fail. */
const CONTROL_ONLY = process.argv.includes('--self-test');
const WITH_CONTROL = process.argv.includes('--with-self-test');
let SELF_TEST = CONTROL_ONLY;
if (CONTROL_ONLY && WITH_CONTROL) throw new Error('choose --self-test or --with-self-test');
/** Re-record the baseline instead of asserting against it. The diff is then reviewed in the PR. */
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
/**
 * What `init` planned, last time somebody looked and agreed with it.
 *
 * Committed, so a change to the shape of an install shows up as a reviewable diff rather than as
 * nothing at all. Kept beside the gate rather than in a scratch directory for the same reason.
 */
const BASELINE_PATH = join(ROOT, 'apps/e2e/install-baseline.json');
const BASELINE = (() => {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return {};
  }
})();
const nextBaseline = {};
const ONLY = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;

/**
 * A LOCAL REGISTRY, not `file:` wiring.
 *
 * Three approaches were tried and two are dead ends, which is worth writing down because both look
 * reasonable:
 *
 *   - tarballs: the fixtures repo's rule against them stands — repeated `npm i --no-save *.tgz`
 *     pruned transitive deps and mixed a published core with a local plugin.
 *   - `file:` deps: npm SYMLINKS them, which Vite resolves and Next does not (`Can't resolve
 *     '@reticlehq/react'` from pages/_app). `--install-links` copies instead, and then npm cannot
 *     resolve `workspace:*` at all — EUNSUPPORTEDPROTOCOL.
 *
 * Verdaccio is the documented answer (docs/local-registry.md) and the only one that produces a REAL
 * install: `pnpm publish` resolves `workspace:*` to concrete versions, and the app then runs the same
 * `npm i @reticlehq/...` a user runs. It also lets `init` do its OWN dependency install, which is a
 * step the gate previously had to skip and then excuse.
 */
const REGISTRY_PORT = Number(process.env.INSTALL_GATE_REGISTRY_PORT ?? '4873');
const REGISTRY = `http://127.0.0.1:${String(REGISTRY_PORT)}`;

/**
 * The registry the gate publishes into — INSTALLED, not fetched at gate time.
 *
 * This used to be `npx --yes verdaccio@latest`, which is a network fetch on every one of twenty
 * matrix cells, and on Windows it is the least reliable line in the gate. Observed on one run: the
 * self-test's fetch sat silent for the full 240s wait and was killed, and the real run eleven
 * seconds later got `'verdaccio' is not recognized as an internal or external command` — the killed
 * fetch had left npx's cache half-written, so the failure MOVED from the cell that caused it to the
 * next one. The nuxt cell's `ERR_MODULE_NOT_FOUND` on an unrelated diff was the same thing. Every
 * one of those reads as "the install gate failed", which is the one sentence this gate exists to
 * mean something by.
 *
 * As a devDependency of `@reticlehq/e2e` it arrives with the `pnpm install --frozen-lockfile` CI
 * already runs, at a version the lockfile pins. Spawned through `node` and its bin script rather
 * than the `.bin` shim, so Windows needs no `.cmd` and no `shell: true`.
 */
const VERDACCIO_BIN = join(ROOT, 'apps/e2e/node_modules/verdaccio/bin/verdaccio');

async function startLocalRegistry() {
  await freePortSafely(REGISTRY_PORT);
  // Storage and htpasswd are relative to the config. A fresh config directory isolates both
  // without deleting state another registry may own. Override listen explicitly: the checked-in
  // default must not silently ignore INSTALL_GATE_REGISTRY_PORT.
  const config = join(mkdtempSync(join(tmpdir(), 'reticle-gate-verdaccio-')), 'verdaccio.yaml');
  writeFileSync(
    config,
    readFileSync(join(ROOT, 'scripts/verdaccio.yaml'), 'utf8')
      // The config file pins 4873. Without this, INSTALL_GATE_REGISTRY_PORT moved every URL the gate
      // uses and not the port Verdaccio binds, so a second registry on the machine made the gate die
      // with EADDRINUSE before a single scaffold ran.
      .replace('listen: 127.0.0.1:4873', `listen: 127.0.0.1:${String(REGISTRY_PORT)}`),
  );
  const proc = spawn(process.execPath, [VERDACCIO_BIN, '--config', config], {
    cwd: ROOT,
    detached: !WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  // A dead registry and a slow one produced the SAME message — "did not start", 90 seconds later,
  // with an empty log — because nothing watched the process itself. That happened on Windows and cost
  // a whole run's coverage to a cause nobody could name. `error` catches a spawn that never began
  // (a .cmd resolved wrong, a missing binary); `exit` catches one that began and died.
  let spawnError;
  let exited;
  proc.on('error', (err) => {
    spawnError = err;
  });
  proc.on('exit', (code, signal) => {
    exited = `exit ${String(code)}${signal === null ? '' : ` (${signal})`}`;
  });

  // `npx --yes verdaccio@latest` resolves and can cold-download the package before it serves
  // anything, and Windows runners are markedly slower at that file IO. 90s is generous for a healthy
  // start and tight for a cold install, which is the shape of the failure seen here. Raised on
  // Windows only, so a genuine hang on the other platforms still surfaces at the same speed.
  const deadline = Date.now() + (WIN ? 240_000 : 90_000);
  let up = false;
  // Stop the moment the process is gone: waiting out 90 seconds for something that already died
  // buys nothing and hides why.
  while (Date.now() < deadline && spawnError === undefined && exited === undefined) {
    if (await reachable(`${REGISTRY}/-/ping`)) {
      up = true;
      break;
    }
    await sleep(500);
  }
  if (!up) {
    killTree(proc.pid);
    const cause =
      spawnError !== undefined
        ? `spawn failed: ${spawnError.message}`
        : exited !== undefined
          ? `the process ${exited} before the registry answered`
          : `timed out after ${String(WIN ? 240 : 90)}s with the process still alive`;
    const tail = log.join('').trim();
    throw new Error(
      `verdaccio did not start on ${REGISTRY} — ${cause}. ` +
        `command: ${process.execPath} ${VERDACCIO_BIN} --config ${config}. ` +
        `output: ${0 === tail.length ? '(nothing on stdout or stderr)' : tail.slice(-400)}`,
    );
  }

  // From here on the registry is RUNNING, and every remaining step can throw. Left unguarded, one
  // of them did: a prepack that failed on Windows aborted the publish, this function threw, and the
  // verdaccio it had started outlived the process. The next run then found port 4873 already held
  // by a registry carrying the previous run's htpasswd, so the user create returned nothing and the
  // gate reported "no token from verdaccio" — a second, unrelated-looking failure that hid the
  // first. A registry this function started is this function's to stop on the way out.
  try {
    return await publishInto(proc);
  } catch (err) {
    killTree(proc.pid);
    throw err;
  }
}

/** Everything that needs the registry to be up. Split out only so the caller above can guard it. */
async function publishInto(proc) {
  const res = await fetch(`${REGISTRY}/-/user/org.couchdb.user:reticle`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _id: 'org.couchdb.user:reticle',
      name: 'reticle',
      password: 'reticle',
      type: 'user',
      roles: [],
      date: '2026-01-01T00:00:00.000Z',
    }),
  });
  const token = (await res.json())?.token;
  if (typeof token !== 'string' || token === '') throw new Error('no token from verdaccio');

  // Auth through an ISOLATED npmrc, pointed at by npm_config_userconfig.
  //
  // The env-var form (`npm_config_//localhost:PORT/:_authToken`) worked on my machine and failed in
  // CI, which is the whole reason this gate needed to run there: locally a developer's own ~/.npmrc
  // can be carrying credentials that make the publish succeed for a reason the gate is not testing.
  // A temp userconfig is unambiguous and still never touches the developer's global npmrc — which
  // scripts/local-registry.sh does append to, and which a killed run would leave a token in.
  const npmrc = join(mkdtempSync(join(tmpdir(), 'reticle-gate-npmrc-')), '.npmrc');
  writeFileSync(
    npmrc,
    `registry=${REGISTRY}\n//127.0.0.1:${String(REGISTRY_PORT)}/:_authToken=${token}\n`,
  );
  const auth = { npm_config_userconfig: npmrc, NPM_CONFIG_USERCONFIG: npmrc };
  if (PREBUILT_PACKAGES !== undefined) {
    for (const tarball of PREBUILT_PACKAGES) {
      await run('npm', ['publish', tarball, '--registry', REGISTRY, '--ignore-scripts', '--provenance=false'], ROOT, auth);
    }
  } else {
    // The protocol has its own version. On a patch release pnpm sees its unchanged version on
    // public npm and skips it, leaving the temporary registry without a dependency that the
    // freshly published server and core still require. Publish it here first so every scaffold
    // installs the entire candidate from this registry.
    await run('npm', ['publish', '--registry', REGISTRY, '--provenance=false'], join(ROOT, 'open-verification'), auth);
    await run('pnpm', ['-r', 'publish', '--registry', REGISTRY, '--no-git-checks'], ROOT, auth, PUBLISH_TIMEOUT_MS);
  }
  return { proc, auth, stop: () => killTree(proc.pid) };
}

/** Where a scaffold's create command puts the app, relative to the workdir. */
const DEFAULT_APP_DIR = 'app';
/** A lockfile only has to EXIST to pick a package manager — nothing here parses it. */
const PNPM_LOCK = 'pnpm-lock.yaml';
const PNPM_LOCK_STUB = "lockfileVersion: '9.0'\n";

/**
 * One per DISTINCT init path. Not one per framework anyone can name — a scaffold that exercises a
 * path another scaffold already covers costs two minutes a run and proves nothing new.
 *
 * Optional fields, all defaulting to the single-app shape the first three use:
 *   - `appDir`   — where the create command puts the app (default `app/`)
 *   - `initFrom` — the directory `init` is invoked from (default: the app's)
 *   - `create`   — the scaffold command. Omitted only where no usable one exists (see `cra`)
 *   - `files`    — files written into the WORKDIR instead of, or on top of, a create command
 *   - `seed`     — extra files written into the WORKDIR after scaffolding, before install
 *   - `hidePnpm` — make `pnpm` unusable for the `init` call only
 *   - `dropLocalLockfile` — delete the app's own lockfile after install, so package-manager
 *     detection has to walk UP for one instead of short-circuiting on it
 */
/**
 * The ports a scaffold's OWN `npm run dev` can bind — the one `init` spawns, which takes no
 * `--port` because the whole point is to run what the user runs.
 *
 * The gate's own dev server is given an explicit port and cannot collide. `init`'s cannot: every
 * Vite scaffold defaults to 5173 and every Next one to 3000, in BOTH phases of this job. The
 * self-test runs first and deliberately wires each app to a bridge port its daemon is not on, so
 * what it leaves listening is an SDK-instrumented page that never dials — and if one survives, the
 * real run's `init` finds that port already answering, watches it, and times out reporting
 * "The SDK IS in the page … and never dialled the bridge". That is the self-test's designed
 * symptom, attributed to a scaffold that was installed correctly.
 *
 * Observed on Windows: `vite-react`'s init announced :5175, which is only reachable if 5173 AND
 * 5174 were already held when it started.
 *
 * The fallback range matters as much as the default. Freeing only 5173 leaves a leftover on 5174,
 * and Vite walks up to it — so the range covers where the framework walks, not just where it starts.
 */
const INIT_DEV_PORTS = {
  vite: [5173, 5174, 5175],
  next: [3000, 3001, 3002],
  astro: [4321, 4322, 4323],
  angular: [4200, 4201, 4202],
};

/**
 * NOT `INSTALL_PROBE_TESTID`, and the difference is load-bearing.
 *
 * `domTestids` (adapters/realm/browser/src/registry/auto-testids.ts) drops every observed testid whose
 * name begins `reticle-`, because Reticle's own overlay stamps testids and they are not the host
 * app's surface. The stamped probe id starts with exactly that, so a `reticle-install-probe` in the
 * DOM is filtered out and `hasCapabilities` stays false — measured on astro, which failed this way
 * with the markup already in place. It only counts on the Vite and Next paths because there it is
 * DECLARED through `registerCapabilities`, and declared ids are not filtered.
 *
 * The stamped id cannot simply be renamed: `capabilities.test.ts` pins that exact string.
 */
const PROBE_MARKUP_TESTID = 'install-probe';

/**
 * Create React App, HAND-BUILT, because there is no scaffold command left to run.
 *
 * `create-react-app` is deprecated and its own CLI now refuses to scaffold; every other framework
 * here gets its official generator and this one cannot. That is not a reason to leave CRA
 * uncovered — the gate tests `reticle init`, not `create-react-app`, and init's CRA path keys off
 * exactly one signal (`react-scripts` in the dependencies, detect.ts) plus the directory shape it
 * writes into (`public/index.html`, `src/index.js`).
 *
 * JavaScript, not TypeScript, on purpose: `craDevModulePath(false)` is the branch that once emitted
 * a `.ts` module into an app with no tsconfig, so the first compile after a green init failed.
 *
 * react-scripts 5 pinned: 4 runs webpack 4, whose parser predates the optional chaining our browser
 * package ships, and init correctly REFUSES that combination — a legitimate ⚠ that would paint this
 * scaffold red for a reason that is not a regression.
 */
const CRA_FILES = {
  'app/package.json': `${JSON.stringify(
    {
      name: 'cra-fixture',
      version: '0.1.0',
      private: true,
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        'react-scripts': '5.0.1',
      },
      scripts: { start: 'react-scripts start', build: 'react-scripts build' },
      browserslist: { production: ['>0.2%'], development: ['last 1 chrome version'] },
    },
    null,
    2,
  )}\n`,
  'app/public/index.html':
    '<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>CRA fixture</title></head>\n' +
    '  <body><div id="root"></div></body>\n</html>\n',
  'app/src/index.js':
    "import React from 'react';\nimport { createRoot } from 'react-dom/client';\n" +
    'createRoot(document.getElementById(\'root\')).render(\n' +
    `  <h1 data-testid="${PROBE_MARKUP_TESTID}">CRA fixture</h1>,\n);\n`,
};

/**
 * The probe testid IN THE RENDERED MARKUP, for a framework whose `init` writes no capabilities file.
 *
 * `stampInstallProbe` plants the same id in a source file, and on the Vite and Next paths that is
 * enough: `init` SCANS the source and bakes the id into the `registerCapabilities` call it
 * generates. Astro's plan has no such step, so that stamp is inert there and the app came up
 * `hasCapabilities: false` — connected and unverifiable.
 *
 * A testid in the DOM is the other half of the same question, and the product answers it
 * deliberately: `hasCapabilities()` (adapters/realm/browser/src/registry/capabilities.ts) counts LIVE
 * testids as well as declared ones, precisely so an app with a testable surface is not reported as
 * having none just because nobody typed the facts into a config file. So this is the realistic
 * probe, not a weakened one — the assertion still requires a session that connects AND advertises
 * something to drive. What it stops requiring is a capabilities FILE, which `init` does not write
 * on these stacks (see the finding note above SCAFFOLDS).
 */
const PROBE_MARKUP = {
  astro: {
    'app/src/pages/index.astro':
      '---\n---\n\n<html lang="en">\n  <head><meta charset="utf-8" /><title>Astro</title></head>\n' +
      `  <body>\n    <h1 data-testid="${PROBE_MARKUP_TESTID}">Astro</h1>\n  </body>\n</html>\n`,
  },
  sveltekit: {
    'app/src/routes/+page.svelte': `<h1 data-testid="${PROBE_MARKUP_TESTID}">SvelteKit</h1>\n`,
  },
  nuxt: {
    'app/app/app.vue': `<template>\n  <h1 data-testid="${PROBE_MARKUP_TESTID}">Nuxt</h1>\n</template>\n`,
  },
  // The root component's template. `<router-outlet />` stays, so the app is still the scaffold's app.
  angular: {
    'app/src/app/app.html': `<h1 data-testid="${PROBE_MARKUP_TESTID}">Angular</h1>\n<router-outlet />\n`,
  },
};

const SCAFFOLDS = [
  {
    id: 'vite-react',
    what: 'Vite + React — the vite-plugin path (config patch + injected connect)',
    initDevPorts: INIT_DEV_PORTS.vite,
    create: ['npm', ['create', 'vite@latest', 'app', '--yes', '--', '--template', 'react-ts']],
  },
  {
    // The NON-REACT path, and the reason it is here is not hypothetical. 2.8.0 nearly shipped an
    // installer that left a Vue app connecting 0% of the time: `init` correctly gives a Vue codebase
    // the framework-neutral `@reticlehq/browser`, and three separate generators still emitted
    // `import('@reticlehq/react')` — the vite-plugin's injected connect among them. Every file init
    // wrote was correct, every gate was green, and nothing dialled the daemon.
    //
    // That is the same shape as the Next.js install this gate was built for, on a different stack:
    // the failure is silent, and only opening a browser can see it. Vue rather than Svelte because
    // it is the larger population; both take the identical code path through the plugin.
    id: 'vite-vue',
    what: 'Vite + Vue — the non-React path (sensor instead of the React kit)',
    initDevPorts: INIT_DEV_PORTS.vite,
    create: ['npm', ['create', 'vite@latest', 'app', '--yes', '--', '--template', 'vue']],
  },
  {
    // The app with NO vite.config at all, which is what `npm create vite`'s vanilla template ships.
    // A fresh-install walk found init answering it with a manual paste-this step, a non-zero exit, and
    // `@reticlehq/react` installed into an app with no React. Init now writes the config and gives
    // it the sensor; only a real browser proves the created file actually connects.
    id: 'vite-vanilla',
    what: 'Vite, vanilla — no vite.config to patch, so init must create one',
    initDevPorts: INIT_DEV_PORTS.vite,
    create: ['npm', ['create', 'vite@latest', 'app', '--yes', '--', '--template', 'vanilla-ts']],
  },
  {
    id: 'next-app-router',
    what: 'Next App Router — withReticle plus the app/ root layout',
    initDevPorts: INIT_DEV_PORTS.next,
    create: [
      'npx',
      [
        'create-next-app@latest',
        'app',
        '--ts',
        '--app',
        '--no-src-dir',
        '--no-tailwind',
        '--no-eslint',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
    ],
  },
  {
    id: 'next-pages-router',
    // The one that matters. No `app/` directory exists, so the root layout init patches is not there
    // and connect has to mount through `pages/_app` — a different code path, and the one that
    // silently did nothing.
    what: 'Next Pages Router — no app/ at all, so connect must mount via pages/_app',
    initDevPorts: INIT_DEV_PORTS.next,
    create: [
      'npx',
      [
        'create-next-app@latest',
        'app',
        '--ts',
        '--no-app',
        '--no-src-dir',
        '--no-tailwind',
        '--no-eslint',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
    ],
  },
  {
    id: 'monorepo-subdir',
    // Not a fourth flavour of the same shape — the first genuinely different one. The other three are
    // single-app roots with `init` run inside the app, and that shape is why this gate was blind to
    // all FOUR init defects one user hit in eight minutes on 2026-08-10: the app was in `frontend/`,
    // the repo root had no package.json, and the root carried a pnpm lockfile the app did not use.
    //
    // Four things are only reachable here:
    //   1. discovery — `init` from a root with no manifest has to FIND `frontend/` (it used to bail
    //      with "No package.json found" before discovery ever ran).
    //   2. the same bail made `--app frontend` unreachable too, i.e. the documented workaround for
    //      (1) failed the same way (one run can only take one of these two paths; discovery is the
    //      one a user hits without reading anything, so it is the one wired up).
    //   3. package-manager precedence: an ancestor `pnpm-lock.yaml` must NOT beat the npm-installed
    //      tree sitting in `frontend/`. With pnpm unusable, a regression here is not a cosmetic
    //      mis-detection — `pnpm add -D` simply cannot run, and the install step goes ⚠. This one
    //      only becomes reachable together with `dropLocalLockfile`: with the app's own lockfile
    //      present, detection short-circuits on it and the ancestor is never read at all.
    //   4. and a failed install must not silently skip the downstream wiring, which the baseline
    //      diff catches: the steps after it would vanish from the plan.
    what: 'monorepo root, app in frontend/, inherited pnpm lockfile, no pnpm on PATH',
    appDir: 'frontend',
    initFrom: '.',
    initDevPorts: INIT_DEV_PORTS.next,
    seed: { [PNPM_LOCK]: PNPM_LOCK_STUB },
    hidePnpm: true,
    dropLocalLockfile: true,
    create: [
      'npx',
      [
        'create-next-app@latest',
        'frontend',
        '--ts',
        '--app',
        '--no-src-dir',
        '--no-tailwind',
        '--no-eslint',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
    ],
  },
  // ── the frameworks that own their own HTML ───────────────────────────────────────────────────
  //
  // Astro, SvelteKit, Nuxt and React Router render the document themselves, so the Vite plugin's
  // `transformIndexHtml` hook never fires and a connect script injected there never reaches the
  // page. That is not a hypothetical class: it is #678 (React Router framework mode reported every
  // step green and produced zero sessions for 20+ minutes) and #741. `init` detects all four in
  // their own right — they are four of the eight members of the `Framework` enum — and until this
  // was written not one of them was scaffolded here, so the only paths this gate watched were the
  // two where HTML injection works.
  //
  // Nuxt and React Router used to be absent, and the absence was the finding: on both, `init` ended
  // with a `[⚠]` and said so itself — "This app will NOT connect until the ⚠ step above is done by
  // hand". `nuxtSteps` and `reactRouterSteps` each emitted exactly one MANUAL step carrying the
  // whole recipe, so "zero ⚠" could not hold for them and a cell that is red by design teaches a
  // reader to ignore this gate. `init` now WRITES both files (the Nuxt client plugin plus its
  // nuxt.config patch, and the React Router client entry), so they belong here.
  {
    id: 'nuxt',
    // Nuxt owns its own Vite instance and renders its own HTML, so nothing of ours is in the page's
    // path to inject the pairing token — it has to be inlined by nuxt.config, and the plugin that
    // connects has to be one Nuxt itself auto-registers. Two writes that only a browser can prove.
    what: 'Nuxt — framework-owned Vite and HTML, so the connect is a .client plugin + a config patch',
    initDevPorts: INIT_DEV_PORTS.next,
    create: [
      'npx',
      ['--yes', 'nuxi@latest', 'init', 'app', '--template', 'minimal', '--packageManager', 'npm', '--no-gitInit', '--no-install'],
    ],
    files: PROBE_MARKUP.nuxt,
  },
  {
    id: 'react-router',
    // #678 in its own cell: framework mode renders HTML through its own request handler, the Vite
    // plugin's transformIndexHtml never fires, and every step reported green over an app that
    // produced zero sessions for 20+ minutes.
    what: 'React Router framework mode — the client entry init writes, because HTML injection never fires',
    initDevPorts: INIT_DEV_PORTS.vite,
    create: ['npx', ['--yes', 'create-react-router@latest', 'app', '--no-install', '--no-git-init', '--yes']],
  },
  {
    id: 'astro',
    what: 'Astro — framework-owned HTML, so the connect arrives through the Astro integration',
    initDevPorts: INIT_DEV_PORTS.astro,
    create: [
      'npm',
      ['create', 'astro@latest', 'app', '--', '--template', 'minimal', '--no-install', '--no-git', '--skip-houston', '-y'],
    ],
    files: PROBE_MARKUP.astro,
  },
  {
    id: 'sveltekit',
    what: 'SvelteKit — Vite underneath, but SSR renders the document, and Svelte is not React',
    initDevPorts: INIT_DEV_PORTS.vite,
    // Newer sv releases pull a runtime: dependency that npm 10.9 cannot resolve on our supported
    // Node 22.14 floor. Keep this generator at the last version this gate has exercised there.
    create: ['npx', ['--yes', 'sv@0.17.1', 'create', 'app', '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install']],
    files: PROBE_MARKUP.sveltekit,
  },
  {
    id: 'cra',
    what: 'Create React App — hand-built fixture, JS not TS, react-scripts 5 (see CRA_FILES)',
    initDevPorts: INIT_DEV_PORTS.next,
    files: CRA_FILES,
  },
  {
    id: 'remix',
    // Remix v2 on Vite was classified as plain Vite: the plugin's index.html injection never reaches
    // a page Remix renders itself, so init reported green over an app that never connected. It is
    // React Router framework mode under its old name, with its own default client entry
    // (`RemixBrowser`) that init has to write whole, because `app/entry.client.tsx` only exists after
    // `remix reveal`.
    //
    // Pinned, both halves, because neither `@latest` works any more. `create-remix` 2.17 refuses to
    // scaffold and points at create-react-router, and every 2.x fetches its template from the remix
    // repository's default branch, which is no longer Remix v2 — so the template is named at the
    // matching release tag. Remix v2 is in maintenance; the pin is the app its users actually have.
    what: 'Remix v2 on Vite — its own client entry, because Remix renders the document itself',
    initDevPorts: INIT_DEV_PORTS.vite,
    create: [
      'npx',
      [
        '--yes',
        'create-remix@2.16.8',
        'app',
        '--template',
        'https://github.com/remix-run/remix/tree/remix@2.16.8/templates/remix',
        '--no-install',
        '--no-git-init',
        '--yes',
      ],
    ],
  },
  {
    id: 'angular',
    // Angular used to fall through to the plain-HTML path: the React kit, the wrong index.html, and
    // snippets that did not compile or that shipped the pairing token. init now patches the browser
    // entry with an isDevMode() connect and serves the token from a proxy config that only `ng serve`
    // loads — three edits, one of them to angular.json, that only a browser can prove connect.
    //
    // No SSR: the SSR build adds a server entry, not a different connect path. `@angular/cli@21`, not
    // `@latest`: 22 refuses to run below Node 22.22.3, and this repo supports Node from 22.12, so an
    // unpinned scaffold would fail on a supported machine for a reason that is not about Reticle.
    // Raise the pin when the repo's own Node floor moves past 22's.
    what: 'Angular 17+ (no SSR) — isDevMode() connect in the entry, the token over an ng-serve proxy',
    initDevPorts: INIT_DEV_PORTS.angular,
    // npm 10.9.2 crashes in Arborist's peer-set builder on the current Angular 21/Vitest
    // scaffold before Reticle is installed. Resolve that scaffold once; the resulting lockfile
    // lets init exercise its normal npm install path against the local registry.
    installArgs: ['--legacy-peer-deps'],
    create: [
      'npx',
      [
        '--yes',
        '@angular/cli@21',
        'new',
        'app',
        '--ssr=false',
        '--skip-git',
        '--skip-install',
        '--defaults',
        '--interactive=false',
      ],
    ],
    files: PROBE_MARKUP.angular,
  },
];

/**
 * A PATH on which `pnpm` cannot run.
 *
 * SHADOWED, not stripped. Dropping the PATH entry that holds pnpm is the obvious move and it is a
 * trap: on plenty of machines (the maintainer's included) `pnpm`, `npm` and `npx` share one bin
 * directory, so removing it takes the package manager the scaffold actually needs with it and the
 * scaffold fails for a reason that has nothing to do with the thing under test. A stub that exits
 * 127 the way an absent binary does is indistinguishable to `init`, which never probes for pnpm — it
 * just runs it — and leaves everything else on PATH alone.
 */
function pathWithoutPnpm(workdir) {
  const binDir = join(workdir, '.gate-no-pnpm');
  mkdirSync(binDir, { recursive: true });
  // A shebang script is not executable on Windows; the shim a Windows shell would find is `pnpm.cmd`
  // earlier on PATH. Both exit 127, which is what `init` reads as "pnpm is not on this machine".
  if (WIN) writeFileSync(join(binDir, 'pnpm.cmd'), '@echo pnpm: command not found 1>&2\r\n@exit /b 127\r\n');
  else
    writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\necho "pnpm: command not found" >&2\nexit 127\n', {
      mode: 0o755,
    });
  return `${binDir}${delimiter}${process.env.PATH ?? ''}`;
}


/**
 * Everything that can say WHY a session never appeared, printed where the failure is.
 *
 * Two independent witnesses, because they fail differently: the page knows whether it tried, and
 * the daemon knows whether it refused. `origin_rejected` in the daemon log is the difference
 * between "the app never dialled" and "the app dialled and the gate said no" — opposite bugs with
 * opposite fixes, indistinguishable from the browser side alone.
 */
function dumpEvidence(consoleLines, bridgePort, failedResponses = [], wsAttempts = []) {
  const say = (label, body) => {
    const text = String(body).trim();
    if (0 === text.length) return;
    console.log(`      ── ${label} ──`);
    for (const line of text.split('\n').slice(-40)) console.log(`      ${line.slice(0, 300)}`);
  };
  say('page console', consoleLines.join('\n'));
  say('non-2xx responses', failedResponses.join('\n'));
  say('websocket attempts', wsAttempts.join('\n'));
  // Which daemon claims which project. Discovery is registry-first, so when a page dials a port the
  // harness is not watching, this is the file that says why it chose that one.
  const stateHome = GATE_STATE_DIR;
  try {
    const claims = readdirSync(stateHome)
      .filter((f) => f.startsWith('connected-'))
      .map((f) => `${f}: ${readFileSync(join(stateHome, f), 'utf8').slice(0, 200)}`);
    say('daemon registry', claims.join('\n'));
  } catch {
    say('daemon registry', `not readable in ${stateHome}`);
  }
  const daemonLog = join(GATE_STATE_DIR, `daemon-${String(bridgePort)}.log`);
  try {
    say(`daemon log (${daemonLog})`, readFileSync(daemonLog, 'utf8'));
  } catch {
    say('daemon log', `not readable at ${daemonLog}`);
  }
}

const execFileAsync = promisify(execFile);
// Keep consuming the registry/dev-server pipes while npm runs. A synchronous child blocks
// those readers, eventually backing up a noisy registry and hanging its own npm install.
const runCaptured = async (cmd, args, cwd, extraEnv = {}, timeoutMs = 600_000) => {
  const it = pm(cmd, args);
  return execFileAsync(it.cmd, it.args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    timeout: timeoutMs,
    ...it.shellOpts,
  });
};
const run = async (...args) => (await runCaptured(...args)).stdout;

/**
 * The workspace publish gets its own, much larger budget.
 *
 * Every package's `prepack` runs `tsc -b --force`, so this builds the whole workspace from cold
 * before a single scaffold exists. MEASURED on Windows: the identical publish via
 * `scripts/local-registry.sh` took ~32 minutes, against the shared 10-minute budget — so the gate
 * died in its own setup with `spawnSync C:\WINDOWS\system32\cmd.exe ETIMEDOUT` and reported
 * `0/1 scaffolds`, which reads as an install failure and is not one.
 *
 * Generous on purpose, and a bound rather than a measurement: this is the harness paying for a
 * build, not a claim about how fast a build should be.
 */
const PUBLISH_TIMEOUT_MS = 45 * 60_000;

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function sessionsOn(port) {
  try {
    const res = await fetch(`http://localhost:${String(port)}/status`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.sessions) ? body.sessions : [];
  } catch {
    return [];
  }
}

/** Answers at all, polled: a server that is up but busy compiling gets the whole bound. */
async function answersWithin(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await reachable(url)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * `init --json`'s output split in two: the plan and progress lines a person reads, and the one
 * pretty-printed object at the end (`JSON.stringify(outcome, null, 2)` in init-runtime.ts). An
 * init that failed before its runtime phase prints no object, and `result` is undefined.
 */
function splitInitJson(stdout) {
  const at = stdout.lastIndexOf('\n{\n') + 1;
  try {
    return { text: stdout.slice(0, at), result: JSON.parse(stdout.slice(at)) };
  } catch {
    return { text: stdout, result: undefined };
  }
}

/**
 * The first loopback url a dev server printed — its "Local:" line on every framework here. Read
 * independently of init's own parser, so a regression there cannot agree with itself.
 */
function announcedUrlIn(log) {
  const plain = log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  return /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/.exec(plain)?.[0];
}
const hostOf = (url) => {
  try {
    return url === undefined ? undefined : new URL(url).hostname;
  } catch {
    return undefined;
  }
};
const portOf = (url) => {
  try {
    return url === undefined ? undefined : Number(new URL(url).port) || undefined;
  } catch {
    return undefined;
  }
};

/**
 * A module each scaffold's app actually loads, first match wins. Editing one is what makes a dev
 * server write: an HMR update on Vite, a recompile on Next, a rebuild on CRA and Angular.
 */
const EDIT_CANDIDATES = [
  'src/App.tsx',
  'src/App.vue',
  'src/main.ts',
  'app/page.tsx',
  'pages/index.tsx',
  'app/root.tsx',
  'src/routes/+page.svelte',
  'app/app.vue',
  'src/pages/index.astro',
  'src/index.js',
];
const MARKUP_EXTENSIONS = /\.(vue|svelte|astro)$/;

/** Append a comment to the first candidate that exists; its path, or undefined when none does. */
function editSourceAfterHandover(app) {
  const rel = EDIT_CANDIDATES.find((c) => existsSync(join(app, c)));
  if (rel === undefined) return undefined;
  const comment = MARKUP_EXTENSIONS.test(rel)
    ? '\n<!-- edited by the install gate after init handed over -->\n'
    : '\n// edited by the install gate after init handed over\n';
  writeFileSync(join(app, rel), `${readFileSync(join(app, rel), 'utf8')}${comment}`);
  return rel;
}

/**
 * Plant a `data-testid` `init` will scan, so the generated capabilities file registers something.
 *
 * Written where the scan looks (under `src/` when that exists, otherwise the app root). Not imported
 * by the app — the scanner reads source text, and `hasCapabilities` rides on `registerCapabilities`,
 * not on the DOM.
 */
function stampInstallProbe(app) {
  const dir = existsSync(join(app, 'src')) ? join(app, 'src') : app;
  writeFileSync(
    join(dir, INSTALL_PROBE_FILE),
    `export const RETICLE_INSTALL_PROBE = 'data-testid="${INSTALL_PROBE_TESTID}"';\n`,
  );
}

/**
 * The steps `init` reported, as `mark → title`.
 *
 * "Zero ⚠" is an absolute and it is not enough on its own. A step that silently changes mark — ✓ to
 * ℹ, or ✓ to · — still passes that assertion while meaning something different happened, and a step
 * that DISAPPEARS from the plan entirely passes it most comfortably of all, because the thing that
 * would have warned you is the thing that is gone.
 *
 * So the shape of the plan is recorded and diffed. That is the difference between a threshold and a
 * baseline: a threshold answers "is this bad", a baseline answers "is this DIFFERENT", and silent
 * regressions are almost always the second question.
 */
/**
 * Every localhost port init said it was using, so the harness can stop what init handed over.
 *
 * Read out of init's own output rather than assumed from the framework: a scaffold that relocates
 * (5173 taken, vite moves to 5174) would otherwise leave the moved one behind.
 *
 * Two shapes, because init reports two kinds of thing. Dev servers arrive as URLs. The DAEMON
 * arrives as a JSON event — `{"event":"reticle_setup_daemon_started","port":4797}` — and matching
 * only URLs meant it was never swept. That daemon then outlived init holding a registry entry for
 * this scaffold's projectId, and daemon discovery is registry-FIRST by design: the app correctly
 * preferred the live daemon serving its project over the port written into its config at install
 * time. So the page dialled 4797 while the harness watched 4796 and reported "no session ever
 * appeared" about an app that had connected perfectly well to the wrong witness. Harness rule 2 is
 * "own the daemon before the app can dial it", and a daemon left running by init breaks it.
 */
function portsMentionedIn(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)) {
    found.add(Number(m[1]));
  }
  for (const m of String(text).matchAll(/"event":"reticle_setup_daemon_started"[^}]*"port":(\d{2,5})/g)) {
    found.add(Number(m[1]));
  }
  return [...found];
}

function stepsOf(report) {
  return report
    .split('\n')
    .map((line) => /^\s*\[(.)\]\s+(.+?)\s+→\s+(.+)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ mark: m[1], title: m[2].trim(), target: m[3].trim() }));
}

/**
 * One line per step, stable and diffable: mark, title, and TARGET.
 *
 * The first version left the target out, on the assumption it carried absolute paths. It does not —
 * every target is a repo-relative path or a descriptive string — and leaving it out threw away the
 * single most load-bearing fact in the file. `Mount ReticleDev → app/layout.tsx` versus
 * `→ pages/_app.tsx` IS the difference between the two Next paths, so without the target the
 * app-router and pages-router baselines were byte-identical and a regression that mounted the
 * pages-router app into the wrong file would have diffed clean.
 */
const fingerprint = (steps) => steps.map((s) => `${s.mark} ${s.title} → ${s.target}`);

/**
 * Clear the fixture's dev ports before init can adopt whatever is listening there.
 *
 * A dev server THIS gate started (init records each one in the gate's state dir) is stopped, process
 * tree and all; only a stranger is refused. Before, every listener counted as a stranger, so a
 * previous scaffold's server that Windows had not finished releasing either failed the run as an
 * occupied port or was left for the next init to find (#818).
 */
async function clearInitDevPorts(scaffold, note, exceptPort) {
  for (const port of scaffold.initDevPorts ?? []) {
    if (port === exceptPort) continue;
    const stopped = stopGateDevServersOn(port);
    // Windows kills a tree without naming its children, and releases the port a moment later: wait
    // for that before calling whatever is still listening a stranger.
    if (stopped.recorded) await portReleased(port);
    await freePortSafely(port, { onNote: note, ownedPids: stopped.pids });
  }
}

/** How long a stopped dev server gets to let go of its port. */
const PORT_RELEASE_WAIT_MS = 5_000;
const PORT_RELEASE_POLL_MS = 200;

async function portReleased(port) {
  for (let waited = 0; waited < PORT_RELEASE_WAIT_MS; waited += PORT_RELEASE_POLL_MS) {
    if (!portHolders(port).some((holder) => holder.listener)) return;
    await sleep(PORT_RELEASE_POLL_MS);
  }
}

/** Stop the dev servers this gate recorded on `port`: whether there were any, and their pids. */
function stopGateDevServersOn(port) {
  let files = [];
  try {
    files = readdirSync(GATE_STATE_DIR);
  } catch {
    return { recorded: false, pids: [] }; // nothing recorded yet
  }
  let recorded = false;
  const owned = [];
  for (const file of files) {
    if (!/^dev-server-.*\.json$/.test(file)) continue;
    try {
      const record = JSON.parse(readFileSync(join(GATE_STATE_DIR, file), 'utf8'));
      if (portOf(record.url) !== port) continue;
      recorded = true;
      owned.push(...(stopProcessTree(record.pid) ?? []));
    } catch {
      /* a half-written record names nothing we can prove is ours */
    }
  }
  return { recorded, pids: owned };
}

async function stopGateDaemon(port) {
  let ownedPids = [];
  try {
    ownedPids = [Number(readFileSync(join(GATE_STATE_DIR, `daemon-${port}.pid`), 'utf8'))];
  } catch { /* init may have refused before starting a daemon */ }
  await freePortSafely(port, { ownedPids });
}

async function stopGateApp(app) {
  for (const file of readdirSync(GATE_STATE_DIR)) {
    if (!/^dev-server-.*\.json$/.test(file)) continue;
    const record = JSON.parse(readFileSync(join(GATE_STATE_DIR, file), 'utf8'));
    if (record.appDir !== app) continue;
    const ownedPids = stopProcessTree(record.pid) ?? [];
    const port = portOf(record.url);
    if (port !== undefined) await freePortSafely(port, { ownedPids });
  }
}

/** Drive one scaffold end to end. Returns its own tally, so one bad scaffold cannot mask another. */
async function driveScaffold(scaffold, index) {
  let pass = 0;
  let fail = 0;
  const failedChecks = [];
  const chk = (label, ok, detail = '') => {
    console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
    if (ok) {
      pass += 1;
    } else {
      fail += 1;
      failedChecks.push(label);
    }
  };
  const note = (line) => console.log(`   · ${line}`);

  // A port pair per scaffold. Sequential runs would be fine sharing one, but a scaffold that leaves
  // a dev server behind must not be able to make the NEXT scaffold look broken.
  const offset = SELF_TEST ? SELF_TEST_PORT_OFFSET : 0;
  const bridgePort = BRIDGE_PORT_BASE + offset + index * 2;
  const initPort = bridgePort;

  console.log(`\n──────── ${scaffold.id} ────────`);
  note(scaffold.what);
  await freePortSafely(bridgePort);
  await freePortSafely(initPort);

  // `realpathSync.native`, because on Windows `tmpdir()` hands back the 8.3 SHORT form —
  // `C:\Users\RUNNER~1\AppData\Local\Temp`, which is literally what the gate's own log prints.
  // Two paths for one directory is a containment check waiting to fail, and Vite's file server does
  // exactly that: `server.fs.allow` compares a request's resolved path against the workspace root,
  // and a short-form root against a long-form request answers 403 Forbidden. Whether or not that is
  // what bit here, no real user's project lives behind an 8.3 alias, so a gate that tests one is
  // testing a path shape its users do not have. On POSIX this only resolves symlinks — macOS's
  // /var -> /private/var among them, which is the same class of two-names-one-directory problem.
  const workdir = realpathSync.native(
    mkdtempSync(join(tmpdir(), `reticle-install-${scaffold.id}-`)),
  );
  const app = join(workdir, scaffold.appDir ?? DEFAULT_APP_DIR);
  // Where the DAEMON is started: inside the workdir, beside the app and outside it. A user's agent
  // starts the daemon in its own working directory, which is not the app being verified.
  const daemonCwd = join(workdir, 'daemon-cwd');
  // Where `init` is invoked. Defaults to the app, which is the only shape that used to exist here.
  const initFrom = scaffold.initFrom === undefined ? app : join(workdir, scaffold.initFrom);
  let daemon;
  /** The app url init reported in `--json`, whose dev server the gate keeps and must stop after. */
  let appUrl;
  let browser;
  let transport;
  let client;
  /**
   * Ports init said it was using, captured where `report` is in scope.
   *
   * The cleanup that needs them runs in the outer `finally`, which cannot see the try-scoped
   * `report` — reading it there threw a ReferenceError and took the whole gate down after the
   * first scaffold had already passed every assertion.
   */
  let handedOverPorts = [];

  try {
    // ── 1. a surface that has never seen Reticle ──────────────────────────────────────────────
    note('scaffolding…');
    // Once more on failure, after clearing what the first attempt left: the generators fetch their
    // templates over the network, and one blip in `npm create astro@latest` dropped #1497 from the
    // merge queue on 2026-10-09 with nothing of ours involved. A real breakage fails twice.
    if (scaffold.create !== undefined) {
      try {
        await run(scaffold.create[0], scaffold.create[1], workdir);
      } catch (first) {
        note(`scaffold failed once, retrying: ${String(first).slice(0, 160)}`);
        rmSync(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        await run(scaffold.create[0], scaffold.create[1], workdir);
      }
    }
    // Files that ARE the scaffold, for a framework with no generator left to run (see CRA_FILES).
    // Before the probe stamp, which needs the app directory to exist.
    for (const [rel, content] of Object.entries(scaffold.files ?? {})) {
      mkdirSync(dirname(join(workdir, rel)), { recursive: true });
      writeFileSync(join(workdir, rel), content);
    }
    stampInstallProbe(app);
    // Seeded AFTER the create command, never before: `create-next-app` reads the surrounding
    // directory to pick a package manager, and a lockfile planted first would change what it builds.
    for (const [rel, content] of Object.entries(scaffold.seed ?? {})) {
      writeFileSync(join(workdir, rel), content);
    }
    const pkgPath = join(app, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    // `dev` OR `start`: CRA's own template names the script `start`, and `init` accepts either
    // (DEV_SCRIPT_NAMES in init/src/dev-script.ts). Requiring `dev` here would
    // fail a CRA app for being shaped exactly like every CRA app.
    chk(
      'the scaffold is a real app',
      typeof pkg.name === 'string' &&
        ['dev', 'start'].some((s) => pkg.scripts?.[s] !== undefined),
    );
    chk(
      '  and it has never seen Reticle',
      !JSON.stringify(pkg).includes('@reticlehq'),
      'no @reticlehq in the fresh package.json',
    );

    // ── 2. point the app's @reticlehq scope at the local registry ─────────────────────────────
    // The scope must be spelled EXACTLY. `@reticle:registry=` — which this repo's own docs carried
    // until a moment ago — matches nothing, so npm silently falls through to the public registry and
    // the gate would measure the published SDK while reporting on local changes.
    writeFileSync(join(app, '.npmrc'), `@reticlehq:registry=${REGISTRY}\n`);
    await run('npm', ['install', '--no-audit', '--no-fund', ...(scaffold.installArgs ?? [])], app);
    // The lockfile npm just wrote is the reason the inherited-lockfile trap was unreachable here.
    // `resolveLockfiles` returns the moment it sees a LOCAL lockfile — "local is authoritative" — so
    // an ancestor `pnpm-lock.yaml` is never consulted and a scaffold that seeds one passes whether
    // precedence is right, wrong, or the ancestor file is absent entirely. Deleting it leaves exactly
    // the state the user was in: no local lockfile, an npm-installed `node_modules` (whose
    // `.package-lock.json` marker is what detection reads), and a pnpm lockfile one directory up.
    // init writes its own package-lock.json back when it installs, so the registry check below still
    // has one to read.
    if (true === scaffold.dropLocalLockfile) rmSync(join(app, 'package-lock.json'), { force: true });

    // ── 3. the thing under test ────────────────────────────────────────────────────────────────
    // `--no-mcp` for the reason the fixtures gate uses it: registering the MCP server edits global
    // machine state (~/.cursor/mcp.json, the developer's own CLAUDE.md). The gate measures the SDK
    // install, not what it does to whoever runs it.
    //
    // init DOES its own dependency install here, from the local registry. That is the whole point of
    // the registry: the previous `file:`-wired version had to pass `--no-install` and then excuse the
    // ⚠ it produced, which meant the one step most likely to regress was the one step not tested.
    // `init` spawns the app's OWN dev script, which names no port — so it lands on the framework
    // default, the same one every other scaffold and the self-test phase already used. Clear that
    // range FIRST: anything still listening there is a leftover, and `init` cannot tell a leftover
    // that answers from the app it just started. See INIT_DEV_PORTS.
    await clearInitDevPorts(scaffold, note);

    let report = '';
    let initStderr = '';
    let initExit = 0;
    try {
      const output = await runCaptured(
        'node',
        // `--json`, so the app url is init's own answer rather than one this gate composes. See the
        // hand-over section below for why that matters.
        [CLI, 'init', '--port', String(initPort), '--no-mcp', '--json'],
        initFrom,
        {
          npm_config_registry: REGISTRY,
          ...(true === scaffold.hidePnpm ? { PATH: pathWithoutPnpm(workdir) } : {}),
        },
      );
      report = output.stdout;
      initStderr = output.stderr;
    } catch (err) {
      initExit = err.status ?? 1;
      report = err.stdout ?? '';
      initStderr = err.stderr ?? '';
    }
    // The plan and progress lines, then one JSON object on stdout: the result an agent reads.
    const { text: initText, result: initResult } = splitInitJson(report);
    report = `${initText}${initStderr}`;
    console.log(
      report
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => `      ${l}`)
        .join('\n'),
    );

    handedOverPorts = portsMentionedIn(report);
    chk('init exits 0', initExit === 0, `exit ${String(initExit)}`);
    // Evidence for the OTHER failure path, which had none (#818).
    //
    // `dumpEvidence` ran only when the gate's own session check failed. The intermittent Windows
    // failure is not that check -- it is this one: `init`'s own post-install verification reports
    // "the SDK IS in the page and never dialled the bridge" against the dev server IT started and
    // handed over, `init` exits 1, and then the gate boots the app itself and the session appears
    // fine. So the run ended with a truncated headline and no evidence, and the one hypothesis the
    // message itself names -- "a bridge port that differs on the two sides" -- is answerable from
    // the registry and the daemon log, both of which were right there and never printed.
    //
    // Init drives its own page in a subprocess, so there is no page console to capture here. What
    // there is: which bridge port init was told to use, which ports its report mentions, and which
    // daemon claims which project.
    if (0 !== initExit) {
      note(`init was told to use bridge port ${String(initPort)}`);
      note(`init's report mentions ports: ${handedOverPorts.join(', ') || '(none)'}`);
      dumpEvidence([], bridgePort);
    }

    // The load-bearing assertion, and now an absolute one. A ⚠ is a step nothing performed, so the
    // app never dials the bridge and every tool answers "no browser session connected" — a
    // green-looking install that cannot work. The earlier version of this gate tolerated one ⚠ and
    // had to argue for it; running against a real registry removes the argument.
    const manualLines = report.split('\n').filter((l) => l.includes('[⚠]'));
    chk(
      'init leaves ZERO manual steps',
      manualLines.length === 0,
      manualLines.length === 0 ? 'no ⚠' : manualLines.join(' | ').trim(),
    );
    const noticeLines = report.split('\n').filter((l) => l.includes('[ℹ]'));
    note(
      0 === noticeLines.length
        ? 'no ℹ notices'
        : `${String(noticeLines.length)} ℹ notice(s) — not a ⚠, but the app may still be unobservable`,
    );

    // The baseline diff. See stepsOf() for why "zero ⚠" cannot carry this on its own.
    //
    // The scaffold's own temp directory is folded to `<root>` first. Most targets are repo-relative,
    // but the ones written where the AGENT stands — the `.reticle.json` a redirect leaves at the
    // repo root, and the rule/command files — are absolute by necessity, and an absolute path under
    // `mkdtemp` is different on every run: recording it would make this baseline diff RED forever,
    // for a reason that has nothing to do with init.
    // Both spellings of it: `mkdtemp` hands back `/var/folders/…` on macOS while the `init` process
    // reports its cwd as the resolved `/private/var/folders/…`, and only one of those two ever
    // appears in a given line.
    //
    // LONGEST FIRST, and that is the whole subtlety. One spelling is a suffix of the other, so
    // folding the short one first eats the tail of the long one and leaves `/private<root>` behind
    // — a baseline diff that fails while reporting a path that never existed.
    //
    // The separator is folded too, and only here. `init` prints `<root>\.reticle.json` on Windows
    // and `<root>/.reticle.json` everywhere else, and BOTH are right — that is what a path looks
    // like on each platform. One recorded baseline has to be readable on both, and the thing it
    // exists to catch is a step changing its mark or vanishing from the plan, never which slash the
    // host uses. Without this the monorepo scaffold failed the diff on Windows over one character.
    const foldRoot = (text) =>
      [workdir, realpathSync(workdir)]
        .sort((a, b) => b.length - a.length)
        .reduce((acc, dir) => acc.split(dir).join('<root>'), text)
        .split('<root>\\')
        .join('<root>/');
    const steps = fingerprint(stepsOf(foldRoot(report)));
    const expected = BASELINE[scaffold.id];
    if (UPDATE_BASELINE) {
      nextBaseline[scaffold.id] = steps;
      note(`baseline recorded: ${String(steps.length)} step(s)`);
    } else if (expected === undefined) {
      chk(
        'this scaffold has a recorded baseline',
        false,
        `no baseline for '${scaffold.id}' — run with --update-baseline and commit the diff`,
      );
    } else {
      const same = expected.length === steps.length && expected.every((e, i) => e === steps[i]);
      chk(
        "init's plan matches the recorded baseline",
        same,
        same
          ? `${String(steps.length)} step(s) unchanged`
          : `expected:\n        ${expected.join('\n        ')}\n      got:\n        ${steps.join('\n        ')}`,
      );
    }

    // The SDK must have come from the registry we published to, not from public npm.
    const lock = (() => {
      try {
        return readFileSync(join(app, 'package-lock.json'), 'utf8');
      } catch {
        return '';
      }
    })();
    chk(
      '  and it came from the LOCAL registry, not public npm',
      lock.includes(`127.0.0.1:${String(REGISTRY_PORT)}`),
      lock.includes(`127.0.0.1:${String(REGISTRY_PORT)}`)
        ? 'resolved against the local registry'
        : 'package-lock does not reference the local registry — this measured PUBLISHED code',
    );

    chk(
      '  and init applied something — a run of all `·` would mean it found nothing to do',
      (report.match(/\[✓\]/g) ?? []).length > 0,
      `${String((report.match(/\[✓\]/g) ?? []).length)} ✓ mark(s)`,
    );

    // ── 4. what init handed over, used as it was handed over ────────────────────────────────────
    //
    // The gate used to throw both of these away — it composed `http://localhost:<port>` itself and
    // booted a dev server of its own — and each hid a defect that shipped and killed first runs:
    //
    //   - The URL. On a cold Next 16 first compile init's page probe timed out on `localhost`, moved
    //     on to `127.0.0.1`, which answered first, and reported THAT as the app url. Next blocks its
    //     dev resources for an origin outside `allowedDevOrigins`, so the page never hydrated, the
    //     connect never ran, and init exited 1 on a correct install — green here, because the gate
    //     opened `localhost` itself. So the url is taken from init's `--json` result, and it has to
    //     be on the host the dev server announced.
    //   - The server. init spawned the dev server with piped output, and once init exited nobody held
    //     the read end: the server's next log line was an EPIPE, and it died. A user saw "connected",
    //     then the app and its port went away on the first edit. The gate killed that server and
    //     started its own, so it could never see it die. So the handed-over server is the one driven
    //     here, and it has to still answer after init has exited AND after a source edit, which is
    //     the log line that killed it.
    appUrl = typeof initResult?.url === 'string' ? initResult.url : undefined;
    chk(
      "init's --json names the app url",
      appUrl !== undefined,
      appUrl ?? (initResult === undefined ? 'no JSON result in init output' : 'the result has no url'),
    );
    // Where the handed-over server writes, which init prints; the announced url is read from there.
    const devLogPath = /its output goes to (\S.*)$/m.exec(report)?.[1]?.trim();
    const devLog = () => {
      try {
        return undefined === devLogPath ? '' : readFileSync(devLogPath, 'utf8');
      } catch {
        return '';
      }
    };
    const announced = announcedUrlIn(devLog());
    // react-scripts prints no url outside a tty, and every dev server here binds `localhost` unless
    // told otherwise — which is the host a user types.
    const expectedHost = hostOf(announced) ?? 'localhost';
    chk(
      '  on the host the dev server announced',
      appUrl !== undefined && hostOf(appUrl) === expectedHost,
      `${String(appUrl)} — announced ${announced ?? `nothing (expected ${expectedHost})`}`,
    );
    const appPort = portOf(appUrl);

    // init's DAEMON is not kept: the gate owns the daemon (step 5). Everything else init mentioned
    // is freed too, except the one server this gate is about to drive.
    for (const port of new Set([...handedOverPorts, initPort])) {
      if (port !== appPort) await stopGateDaemon(port);
    }
    await clearInitDevPorts(scaffold, note, appPort);
    handedOverPorts = [];

    // ── 5. own the daemon before the app can dial it (harness rule 2) ───────────────────────────
    //
    // Started in a directory that is NEITHER the app nor a Reticle checkout, and that is the point.
    //
    // It used to run in `ROOT`, this repo — which is a Reticle project, whose own `.gitignore`
    // hides `.reticle/`. So the daemon was always inside a tree that expected its files, and the
    // question "does Reticle write into directories it was not invited into?" could not be asked
    // by any gate. It shipped twice: a `.reticle/` created by the mere act of booting, in whatever
    // directory the user's agent was started in, and a session journal — URLs, request and response
    // bodies, page text — written to that same directory while the ignore file went to the app.
    //
    // A user's daemon is started by their editor, wherever that editor's cwd happens to be. This is
    // that, and `daemonCwd` below is asserted empty after the drive.
    mkdirSync(daemonCwd, { recursive: true });
    daemon = await startOwnedDaemon(bridgePort, { cliPath: CLI, cwd: daemonCwd });
    transport = watchTransport(bridgePort);

    // ── 6. the handed-over server, after init has exited, in a real browser ─────────────────────
    chk(
      "init's dev server still answers after init exited",
      appUrl !== undefined && (await answersWithin(appUrl, HANDOVER_ANSWER_MS)),
      `${String(appUrl)}${devLogPath === undefined ? ' (init named no dev-server log)' : ''}`,
    );

    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const page = await browser.newPage();
    // Block only Reticle's socket. Port mis-wiring can be repaired by project discovery, which
    // made the monorepo control pass and required a waiver. Intercepting the actual connection
    // proves the failure detector without changing init's input or breaking framework HMR.
    let blockedConnections = 0;
    if (SELF_TEST) {
      await page.routeWebSocket((url) => url.pathname === '/reticle', async (route) => {
        blockedConnections += 1;
        await route.close();
      });
    }
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    // WHAT was refused, not just that something was. A console line reading "Failed to load
    // resource: 403 (Forbidden)" cost a full CI round trip on Windows because it names a status and
    // no url — and the two candidates need opposite fixes: a 403 on `ws://…/reticle` is the bridge
    // refusing an origin, a 403 on an `http://…/@fs/…` is Vite refusing to serve a file outside its
    // allow-list. Both are plausible from the console text alone, which is the problem.
    const failedResponses = [];
    const wsAttempts = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failedResponses.push(`${String(r.status())} ${r.url()}`);
    });
    // A websocket that never opens produces no `response` event at all, so it is watched separately.
    page.on('websocket', (ws) => {
      wsAttempts.push(`opened ${ws.url()}`);
      ws.on('socketerror', (e) => wsAttempts.push(`FAILED ${ws.url()} — ${String(e)}`));
    });
    let probeUrl;
    try {
      if (appUrl === undefined) throw new Error('init reported no app url to open');
      const probe = new URL(appUrl);
      probe.searchParams.set('reticle-install-run', randomUUID());
      probeUrl = probe.href;
      await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      consoleLines.push(`goto failed: ${String(err).slice(0, 120)}`);
    }

    // POLL. Steps 6 and 7 of the connection sequence race, and a gate that samples once sits outside
    // the product's own protection against it — see docs/system-map.md.
    //
    // Connected is not verifiable. `hasCapabilities` is announced in HELLO at connect() and
    // re-announced when `registerCapabilities` runs after, so the first snapshot can be false even
    // on a file that registers a testid. Wait for a session, then keep polling for capabilities.
    //
    // And it must be THIS app's session. The daemon answers with every session it holds, and the
    // check used to accept any of them — so a dev server left behind by an earlier scaffold, still
    // dialling this bridge port, satisfied it. Measured: the `cra` scaffold passed on a session
    // whose url was `http://localhost:5173/`, which is a SvelteKit server from the run before it.
    // CRA does not serve 5173 and never did; the gate reported a working CRA install on evidence
    // from a different framework. That is the exact failure this whole file exists to prevent, one
    // level up. The browser above was pointed at init's url, so that is the only session that can
    // answer for what was installed here.
    const isOurs = (s) => sessionMatchesPage(s, probeUrl);
    const connectDeadline = Date.now() + CONNECT_TIMEOUT_MS;
    let sessions = [];
    while (Date.now() < connectDeadline) {
      sessions = (await sessionsOn(bridgePort)).filter(isOurs);
      if (sessions.length > 0) break;
      await sleep(500);
    }
    const capDeadline = Math.min(connectDeadline, Date.now() + CAPABILITIES_WAIT_MS);
    while (Date.now() < capDeadline && !sessions.some((s) => true === s.hasCapabilities)) {
      sessions = (await sessionsOn(bridgePort)).filter(isOurs);
      await sleep(500);
    }

    // ── 6. attribute honestly (harness rule 4) ─────────────────────────────────────────────────
    const { aliveThroughout } = transport.stop();
    const verifiable = sessions.some((s) => true === s.hasCapabilities);
    const verdict = attributeOutcome({
      connected: sessions.length > 0,
      hasCapabilities: verifiable,
      transportAliveThroughout: aliveThroughout,
    });
    if (verdict.outcome === Attribution.INCONCLUSIVE) {
      // Neither a pass nor a clean fail. A scaffold that never had a bridge was never tested, and
      // reporting that as an install failure is how a correct SvelteKit install became a bug report.
      console.log(`   ⚠️  INCONCLUSIVE — ${verdict.because}`);
      chk('transport stayed available', false, verdict.because);
    } else {
      const passed = verdict.outcome === Attribution.PASS;
      chk(
        SESSION_CHECK,
        passed,
        passed
          ? (sessions[0]?.url ?? '')
          : `${verdict.because}; console: ${consoleLines.slice(-3).join(' | ').slice(0, 220)}`,
      );
      // The one-line summary above is a headline, not evidence. A real failure here — the page
      // never dialled, or dialled and was refused — is diagnosed from what the PAGE said and what
      // the DAEMON said, and 220 characters of the last three console lines is enough to know
      // something went wrong and not enough to know what. A `403 (Forbidden)` on Windows cost a
      // whole CI round trip for exactly this reason: it named a status and not an origin.
      if (!passed) dumpEvidence(consoleLines, bridgePort, failedResponses, wsAttempts);
    }

    // HELLO's hasCapabilities is a declaration, not proof that any command answers. Exercise
    // the installed SDK through stdio MCP, without injecting or reconnecting a replacement SDK.
    if (!SELF_TEST && verdict.outcome === Attribution.PASS) {
      const { McpStdioClient } = await import('../../bench/harness/mcp-client.mjs');
      client = new McpStdioClient('node', [CLI, 'mcp', '--port', String(bridgePort)],
        { RETICLE_PORT: String(bridgePort), RETICLE_TELEMETRY: '0' }, { cwd: app });
      await client.start();
      const sessionId = sessions.find((session) => session.hasCapabilities)?.sessionId;
      if (typeof sessionId !== 'string') throw new Error('connected session has no id');
      await page.evaluate((testid) => {
        const button = document.createElement('button');
        button.dataset.testid = testid;
        button.textContent = 'Reticle install probe ready';
        button.addEventListener('click', () => { button.textContent = 'Reticle install probe clicked'; });
        document.body.append(button);
      }, INSTALL_PROBE_TESTID);
      const call = async (name, args) => {
        const raw = await client.request('tools/call', { name, arguments: args }, 15_000);
        if (raw?.isError === true) throw new Error(JSON.stringify(raw));
        return JSON.parse((raw?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n'));
      };
      requireAssertion(await call('reticle_assert', {
        sessionId, predicate: { kind: 'element', query: { by: 'testid', value: INSTALL_PROBE_TESTID } },
        timeout_ms: 5000,
      }), true);
      chk('the installed SDK answers a true assertion over MCP', true);
      requireVerdict(await call('reticle_act_and_wait', {
        sessionId, action: 'click', target: { testid: INSTALL_PROBE_TESTID },
        until: { kind: 'text', contains: 'Reticle install probe clicked' }, timeout_ms: 5000,
      }), true);
      chk('an MCP action changes the installed page',
        await page.getByTestId(INSTALL_PROBE_TESTID).textContent() === 'Reticle install probe clicked');
      requireAssertion(await call('reticle_assert', {
        sessionId, predicate: { kind: 'element', query: { by: 'testid', value: `${INSTALL_PROBE_TESTID}-absent` } },
        timeout_ms: 250,
      }), false);
      chk('the installed SDK refuses a false assertion', true);
    }
    // ── 7. a source edit, which is a log line, and the handed-over server must survive it ──────
    const logBefore = devLog().length;
    const edited = editSourceAfterHandover(app);
    const logDeadline = Date.now() + EDIT_LOG_WAIT_MS;
    while (Date.now() < logDeadline && devLog().length === logBefore) await sleep(500);
    note(
      devLog().length > logBefore
        ? `the dev server wrote to its log after the edit of ${String(edited)}`
        : `the dev server wrote nothing within ${String(EDIT_LOG_WAIT_MS / 1000)}s of the edit`,
    );
    chk(
      '  and still answers after a source edit',
      edited !== undefined && appUrl !== undefined && (await answersWithin(appUrl, HANDOVER_ANSWER_MS)),
      edited === undefined
        ? `none of ${EDIT_CANDIDATES.join(', ')} exists in this scaffold`
        : `edited ${edited}; log tail: ${devLog().slice(-200).replace(/\s+/g, ' ')}`,
    );

    // ── 9. Reticle wrote nothing into the directory it was merely STARTED in ────────────────────
    //
    // The one negative assertion in this gate, and the only kind that can catch this class: every
    // other check here asks whether a file Reticle promised to write is there. Nothing asked
    // whether a file it never promised is somewhere else, so a daemon quietly filling a stranger's
    // repository passed every gate this project has.
    //
    // Listed rather than counted: "the daemon's directory is clean ❌" with no names is a check
    // somebody will delete rather than debug.
    const strays = existsSync(daemonCwd) ? readdirSync(daemonCwd) : [];
    chk(
      'the daemon wrote nothing where it was started',
      strays.length === 0,
      strays.length === 0 ? '' : `left behind: ${strays.join(', ')}`,
    );

    if (SELF_TEST) chk('the negative control intercepted a Reticle socket', blockedConnections > 0);
  } catch (err) {
    chk('the scaffold ran to completion', false, String(err).slice(0, 300));
  } finally {
    transport?.stop();
    await client?.stop();
    await browser?.close();
    if (daemon !== undefined) await daemon.stop();
    await stopGateApp(app);
    await stopGateDaemon(initPort);
    // The server init handed over, which the gate drove instead of starting its own.
    const handedOverAppPort = portOf(appUrl);
    if (handedOverAppPort !== undefined) await freePortSafely(handedOverAppPort);
    // The dev server INIT started and handed over, which is not the one above.
    //
    // Handing it over is the product behaviour: init leaves the user with a running instrumented
    // app. A harness has to clean up after that, and this one did not — so every scaffold left a
    // vite squatting the port the NEXT scaffold's init would ask for, and the run degraded down the
    // list while the first scaffold looked fine. Three "the app boots" failures, none of them about
    // booting.
    for (const port of handedOverPorts) await stopGateDaemon(port);
    if (KEEP) note(`kept: ${workdir}`);
    // A dev server that has just been signalled is still flushing `.next` into this directory, so
    // the first rmdir loses a race it does not have to lose.
    //
    // And it must never decide the run. On Windows a handle survives the process that held it, so
    // this raised `EBUSY: resource busy or locked, rmdir …\app` AFTER a scaffold had passed all
    // nine of its checks — and because the throw escaped a `finally`, it reached the top level and
    // was reported as "the gate could not start", aborting every scaffold behind it. A whole run's
    // worth of Windows coverage lost to a directory that would not delete. A leaked temp directory
    // is a leak; it is not an install failure, and this gate answers exactly one question.
    else {
      try {
        rmSync(workdir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
      } catch (err) {
        note(`could not remove ${workdir} (${String(err).slice(0, 120)}) — leaving it behind`);
      }
    }
  }

  // Name the failing check, not just the count. "8 passed, 1 failed" sent every reader of #818
  // scrolling to find out which one -- and the answer turned out to matter: the intermittent
  // Windows failure is `init exits 0`, while the gate's own session check passes on the same
  // scaffold seconds later.
  const which = 0 === failedChecks.length ? '' : ` (${failedChecks.join('; ')})`;
  console.log(`   ${fail === 0 ? '✓' : '✗'} ${scaffold.id}: ${pass} passed, ${fail} failed${which}`);
  return { id: scaffold.id, pass, fail, failedChecks };
}

console.log('\n=== INSTALL GATE: pristine apps, installed into, opened, and asked to connect ===');
if (SELF_TEST) console.log('   (self-test: Reticle sockets are blocked; only the session check MUST fail)');
await sweepBatteryOrphans([], { onNote: (n) => console.log(`   · ${n}`) });

// Free ports used by either the real run or a preceding self-test (which runs first in CI in the
// same job). On Windows, where detached daemons outlive process termination, an un-freed daemon
// from self-test (e.g. port 4855) stays listening and tricks subsequent scaffolds into probing it.
const allGatePorts = new Set([REGISTRY_PORT]);
for (const offset of [0, SELF_TEST_PORT_OFFSET]) {
  for (let i = 0; i < SCAFFOLDS.length; i++) {
    const b = Number(process.env.INSTALL_GATE_PORT ?? '4788') + offset + i * 2;
    allGatePorts.add(b);
    allGatePorts.add(b + 1);
  }
}
for (const port of allGatePorts) {
  await freePortSafely(port);
}

const chosen = SCAFFOLDS.filter((s) => ONLY === undefined || s.id === ONLY);
if (chosen.length === 0) {
  console.error(`\nno scaffold named '${String(ONLY)}' — have: ${SCAFFOLDS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let registry;
const results = [];
const controlResults = [];
try {
  console.log('   · publishing @reticlehq/* to a local registry…');
  registry = await startLocalRegistry();
  for (const [index, scaffold] of chosen.entries()) {
    // Isolated, for the same reason the CI matrix sets `fail-fast: false`: which scaffolds install
    // and which do not is the entire output of this gate, and one of them throwing used to take the
    // answer for every scaffold behind it. Measured on Windows — vite-react passed all nine checks,
    // then an EBUSY on a temp directory ended the run and four scaffolds were never attempted.
    // A crash is that scaffold's failure to report, not a reason to stop asking the question.
    try {
      if (WITH_CONTROL) {
        SELF_TEST = true;
        console.log('   · negative control');
        controlResults.push(await driveScaffold(scaffold, index));
        SELF_TEST = false;
      }
      results.push(await driveScaffold(scaffold, index));
    } catch (err) {
      console.log(`   ✗ ${scaffold.id} crashed: ${String(err).slice(0, 300)}`);
      results.push({ id: scaffold.id, pass: 0, fail: 1 });
    }
  }
} catch (err) {
  // The reason, not the banner. execFile's message begins with the command and then its STDOUT,
  // so a truncation of it shows npm's package listing and never the error — which is precisely how
  // this failure arrived from CI unreadable.
  const detail = [err?.stderr, err?.stdout, String(err)]
    .filter((part) => 'string' === typeof part && part.trim() !== '')
    .map((part) => part.trim().split('\n').slice(-12).join('\n'))
    .join('\n---\n');
  console.log(`   ❌ the gate could not start:\n${detail.slice(0, 2000)}`);
  results.push({ id: 'setup', pass: 0, fail: 1 });
} finally {
  if (registry !== undefined) registry.stop();
  await freePortSafely(REGISTRY_PORT, { ownedPids: registry === undefined ? [] : [registry.proc.pid] });
}

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...BASELINE, ...nextBaseline }, null, 2)}\n`);
  console.log(`\n   · baseline written to ${BASELINE_PATH} — review the diff before committing`);
}

console.log('\n──────── summary ────────');
for (const r of results) {
  console.log(`   ${r.fail === 0 ? '✅' : '❌'} ${r.id.padEnd(20)} ${r.pass} passed, ${r.fail} failed`);
}

let controlPassed = true;
if (CONTROL_ONLY || WITH_CONTROL) {
  const { ok, problems } = evaluateInstallControl(
    CONTROL_ONLY ? results : controlResults, chosen.map((s) => s.id));
  controlPassed = ok;
  for (const problem of problems) console.error(`   ✗ ${problem}`);
  console.log(`\n${ok ? '✅ SELF-TEST PASSED' : '❌ SELF-TEST FAILED'} — ` +
    'each scaffold must fail only its session check; setup errors and missing evidence fail the control');
  if (CONTROL_ONLY) process.exit(ok ? 0 : 1);
}

const failed = results.filter((r) => r.fail > 0);
console.log(
  `\n${failed.length === 0 ? '✅ INSTALL GATE PASSED' : '❌ INSTALL GATE FAILED'} ` +
    `(${String(results.length - failed.length)}/${String(results.length)} scaffolds)`,
);
process.exit(failed.length === 0 && controlPassed ? 0 : 1);
