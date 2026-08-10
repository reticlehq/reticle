// Tier 1: install Reticle into apps that have never seen it, and check a session actually appears.
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
// Four scaffolds, because `init` has four genuinely different paths into an app. The third matters
// most for framework reasons: a Pages Router app has no `app/` root layout to patch, so connect has
// to mount through `pages/_app` — and that is the path that once did nothing at all, silently.
//
// The fourth is a different axis entirely: the first three are all the same SHAPE — a single-app root
// with `init` run inside it — and that sameness is what made this gate blind to four init defects one
// user hit in eight minutes. `monorepo-subdir` is the shape those live in.
//
//   pnpm gate:install                 # all scaffolds
//   node apps/e2e/install-gate.mjs --only next-pages-router [--keep]
//   pnpm gate:install:self-test       # negative control: every scaffold must go RED
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  freePortSafely,
  startOwnedDaemon,
  watchTransport,
  attributeOutcome,
  Attribution,
  sweepBatteryOrphans,
} from './gate-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages/server/dist/cli.js');
/** Private ports, so this never fights the battery or a developer's own daemon. */
const BRIDGE_PORT_BASE = Number(process.env.INSTALL_GATE_PORT ?? '4788');
const APP_PORT_BASE = Number(process.env.INSTALL_GATE_APP_PORT ?? '4820');
/** Generous: a cold Next build is slow, and a timeout here reads as an install failure. */
const BOOT_TIMEOUT_MS = 180_000;
const CONNECT_TIMEOUT_MS = 45_000;
const KEEP = process.argv.includes('--keep');
/**
 * Negative control: wire the app to a port the daemon is NOT on, so no session can appear, and
 * require the gate to FAIL.
 *
 * `check-boundaries.mjs --self-test` and `check-lossy-transforms.mjs --self-test` already run this
 * way in CI, for the reason this repo keeps rediscovering: a guard that has never failed is not a
 * guard. The session check is the one assertion that proves the install WORKS, so it is the one that
 * most needs to be shown capable of going red.
 */
const SELF_TEST = process.argv.includes('--self-test');
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
const REGISTRY = `http://localhost:${String(REGISTRY_PORT)}`;

async function startLocalRegistry() {
  await freePortSafely(REGISTRY_PORT);
  // The paths scripts/verdaccio.yaml actually uses. Resetting BOTH matters: leave the htpasswd file
  // behind and the second run's user-create returns no token (the user already exists), which
  // presents as "no token from verdaccio" and looks like a registry fault rather than stale state.
  rmSync('/tmp/reticle-verdaccio-storage', { recursive: true, force: true });
  rmSync('/tmp/reticle-verdaccio-htpasswd', { recursive: true, force: true });
  const proc = spawn(
    'npx',
    ['--yes', 'verdaccio@latest', '--config', join(ROOT, 'scripts/verdaccio.yaml')],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));

  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline) {
    if (await reachable(`${REGISTRY}/-/ping`)) {
      up = true;
      break;
    }
    await sleep(500);
  }
  if (!up) throw new Error(`verdaccio did not start on ${REGISTRY}: ${log.join('').slice(-400)}`);

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
    `registry=${REGISTRY}\n//localhost:${String(REGISTRY_PORT)}/:_authToken=${token}\n`,
  );
  const auth = { npm_config_userconfig: npmrc, NPM_CONFIG_USERCONFIG: npmrc };
  run('pnpm', ['-r', 'publish', '--registry', REGISTRY, '--no-git-checks'], ROOT, auth);
  return { proc, auth, stop: () => {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  } };
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
 *   - `seed`     — extra files written into the WORKDIR after scaffolding, before install
 *   - `hidePnpm` — make `pnpm` unusable for the `init` call only
 */
const SCAFFOLDS = [
  {
    id: 'vite-react',
    what: 'Vite + React — the vite-plugin path (config patch + injected connect)',
    create: ['npm', ['create', 'vite@latest', 'app', '--yes', '--', '--template', 'react-ts']],
    dev: (port) => ['npm', ['run', 'dev', '--', '--port', String(port), '--strictPort']],
  },
  {
    id: 'next-app-router',
    what: 'Next App Router — withReticle plus the app/ root layout',
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
    dev: (port) => ['npm', ['run', 'dev', '--', '-p', String(port)]],
  },
  {
    id: 'next-pages-router',
    // The one that matters. No `app/` directory exists, so the root layout init patches is not there
    // and connect has to mount through `pages/_app` — a different code path, and the one that
    // silently did nothing.
    what: 'Next Pages Router — no app/ at all, so connect must mount via pages/_app',
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
    dev: (port) => ['npm', ['run', 'dev', '--', '-p', String(port)]],
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
    //      mis-detection — `pnpm add -D` simply cannot run, and the install step goes ⚠.
    //   4. and a failed install must not silently skip the downstream wiring, which the baseline
    //      diff catches: the steps after it would vanish from the plan.
    what: 'monorepo root, app in frontend/, inherited pnpm lockfile, no pnpm on PATH',
    appDir: 'frontend',
    initFrom: '.',
    seed: { [PNPM_LOCK]: PNPM_LOCK_STUB },
    hidePnpm: true,
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
    dev: (port) => ['npm', ['run', 'dev', '--', '-p', String(port)]],
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
  const stub = join(binDir, 'pnpm');
  writeFileSync(stub, '#!/bin/sh\necho "pnpm: command not found" >&2\nexit 127\n', { mode: 0o755 });
  return `${binDir}${delimiter}${process.env.PATH ?? ''}`;
}

const run = (cmd, args, cwd, extraEnv = {}) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    timeout: 600_000,
  });

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

/** Drive one scaffold end to end. Returns its own tally, so one bad scaffold cannot mask another. */
async function driveScaffold(scaffold, index) {
  let pass = 0;
  let fail = 0;
  const chk = (label, ok, detail = '') => {
    console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
    ok ? (pass += 1) : (fail += 1);
  };
  const note = (line) => console.log(`   · ${line}`);

  // A port pair per scaffold. Sequential runs would be fine sharing one, but a scaffold that leaves
  // a dev server behind must not be able to make the NEXT scaffold look broken.
  const bridgePort = BRIDGE_PORT_BASE + index * 2;
  const appPort = APP_PORT_BASE + index * 2;

  console.log(`\n──────── ${scaffold.id} ────────`);
  note(scaffold.what);
  await freePortSafely(bridgePort);
  await freePortSafely(appPort);

  const workdir = mkdtempSync(join(tmpdir(), `reticle-install-${scaffold.id}-`));
  const app = join(workdir, scaffold.appDir ?? DEFAULT_APP_DIR);
  // Where `init` is invoked. Defaults to the app, which is the only shape that used to exist here.
  const initFrom = scaffold.initFrom === undefined ? app : join(workdir, scaffold.initFrom);
  let daemon;
  let dev;

  try {
    // ── 1. a surface that has never seen Reticle ──────────────────────────────────────────────
    note('scaffolding…');
    run(scaffold.create[0], scaffold.create[1], workdir);
    // Seeded AFTER the create command, never before: `create-next-app` reads the surrounding
    // directory to pick a package manager, and a lockfile planted first would change what it builds.
    for (const [rel, content] of Object.entries(scaffold.seed ?? {})) {
      writeFileSync(join(workdir, rel), content);
    }
    const pkgPath = join(app, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    chk(
      'the scaffold is a real app',
      typeof pkg.name === 'string' && pkg.scripts?.dev !== undefined,
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
    run('npm', ['install', '--no-audit', '--no-fund'], app);

    // ── 3. the thing under test ────────────────────────────────────────────────────────────────
    // `--no-mcp` for the reason the fixtures gate uses it: registering the MCP server edits global
    // machine state (~/.cursor/mcp.json, the developer's own CLAUDE.md). The gate measures the SDK
    // install, not what it does to whoever runs it.
    //
    // init DOES its own dependency install here, from the local registry. That is the whole point of
    // the registry: the previous `file:`-wired version had to pass `--no-install` and then excuse the
    // ⚠ it produced, which meant the one step most likely to regress was the one step not tested.
    let report = '';
    let initExit = 0;
    try {
      report = run(
        'node',
        [CLI, 'init', '--port', String(SELF_TEST ? bridgePort + 1 : bridgePort), '--no-mcp'],
        initFrom,
        {
          npm_config_registry: REGISTRY,
          ...(true === scaffold.hidePnpm ? { PATH: pathWithoutPnpm(workdir) } : {}),
        },
      );
    } catch (err) {
      initExit = err.status ?? 1;
      report = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    console.log(
      report
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => `      ${l}`)
        .join('\n'),
    );

    chk('init exits 0', initExit === 0, `exit ${String(initExit)}`);

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

    // The baseline diff. See stepsOf() for why "zero ⚠" cannot carry this on its own.
    const steps = fingerprint(stepsOf(report));
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
      lock.includes(`localhost:${String(REGISTRY_PORT)}`),
      lock.includes(`localhost:${String(REGISTRY_PORT)}`)
        ? 'resolved against the local registry'
        : 'package-lock does not reference the local registry — this measured PUBLISHED code',
    );

    chk(
      '  and init applied something — a run of all `·` would mean it found nothing to do',
      (report.match(/\[✓\]/g) ?? []).length > 0,
      `${String((report.match(/\[✓\]/g) ?? []).length)} ✓ mark(s)`,
    );

    // ── 4. own the daemon before the app can dial it (harness rule 2) ───────────────────────────
    daemon = await startOwnedDaemon(bridgePort, { cliPath: CLI, cwd: ROOT });
    const transport = watchTransport(bridgePort);

    // ── 5. boot, and open it in a real browser ──────────────────────────────────────────────────
    const [devCmd, devArgs] = scaffold.dev(appPort);
    dev = spawn(devCmd, devArgs, {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
    });
    const devLog = [];
    dev.stdout.on('data', (d) => devLog.push(String(d)));
    dev.stderr.on('data', (d) => devLog.push(String(d)));

    const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
    let booted = false;
    while (Date.now() < bootDeadline) {
      if (await reachable(`http://localhost:${String(appPort)}/`)) {
        booted = true;
        break;
      }
      await sleep(500);
    }
    chk('the app boots', booted, booted ? `:${String(appPort)}` : devLog.join('').slice(-300));

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    try {
      await page.goto(`http://localhost:${String(appPort)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    } catch (err) {
      consoleLines.push(`goto failed: ${String(err).slice(0, 120)}`);
    }

    // POLL. Steps 6 and 7 of the connection sequence race, and a gate that samples once sits outside
    // the product's own protection against it — see docs/system-map.md.
    const connectDeadline = Date.now() + CONNECT_TIMEOUT_MS;
    let sessions = [];
    while (Date.now() < connectDeadline) {
      sessions = await sessionsOn(bridgePort);
      if (sessions.length > 0) break;
      await sleep(500);
    }

    // ── 6. attribute honestly (harness rule 4) ─────────────────────────────────────────────────
    const { aliveThroughout } = transport.stop();
    const verdict = attributeOutcome({
      connected: sessions.length > 0,
      transportAliveThroughout: aliveThroughout,
    });
    if (verdict.outcome === Attribution.INCONCLUSIVE) {
      // Neither a pass nor a clean fail. A scaffold that never had a bridge was never tested, and
      // reporting that as an install failure is how a correct SvelteKit install became a bug report.
      console.log(`   ⚠️  INCONCLUSIVE — ${verdict.because}`);
      fail += 1;
    } else {
      chk(
        'a session actually appears — the only step that proves the install works',
        verdict.outcome === Attribution.PASS,
        verdict.outcome === Attribution.PASS
          ? (sessions[0]?.url ?? '')
          : `${verdict.because}; console: ${consoleLines.slice(-3).join(' | ').slice(0, 220)}`,
      );
    }

    await browser.close();
  } catch (err) {
    chk('the scaffold ran to completion', false, String(err).slice(0, 300));
  } finally {
    if (dev !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    if (daemon !== undefined) await daemon.stop();
    await freePortSafely(appPort);
    if (KEEP) note(`kept: ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
  }

  console.log(`   ${fail === 0 ? '✓' : '✗'} ${scaffold.id}: ${pass} passed, ${fail} failed`);
  return { id: scaffold.id, pass, fail };
}

console.log('\n=== INSTALL GATE: pristine apps, installed into, opened, and asked to connect ===');
if (SELF_TEST) console.log('   (self-test: every scaffold is mis-wired and MUST fail)');
await sweepBatteryOrphans([], { onNote: (n) => console.log(`   · ${n}`) });

const chosen = SCAFFOLDS.filter((s) => ONLY === undefined || s.id === ONLY);
if (chosen.length === 0) {
  console.error(`\nno scaffold named '${String(ONLY)}' — have: ${SCAFFOLDS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let registry;
const results = [];
try {
  console.log('   · publishing @reticlehq/* to a local registry…');
  registry = await startLocalRegistry();
  for (const [index, scaffold] of chosen.entries()) {
    results.push(await driveScaffold(scaffold, index));
  }
} catch (err) {
  // The reason, not the banner. execFileSync's message begins with the command and then its STDOUT,
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
  await freePortSafely(REGISTRY_PORT);
}

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...BASELINE, ...nextBaseline }, null, 2)}\n`);
  console.log(`\n   · baseline written to ${BASELINE_PATH} — review the diff before committing`);
}

console.log('\n──────── summary ────────');
for (const r of results) {
  console.log(`   ${r.fail === 0 ? '✅' : '❌'} ${r.id.padEnd(20)} ${r.pass} passed, ${r.fail} failed`);
}

if (SELF_TEST) {
  // Inverted, and per scaffold. A green here would mean the session check passes regardless of
  // reality, which is the only way this whole script could be worthless while looking fine.
  const undetected = results.filter((r) => r.fail === 0).map((r) => r.id);
  const ok = undetected.length === 0;
  console.log(
    `\n${ok ? '✅ SELF-TEST PASSED' : '❌ SELF-TEST FAILED'} — ` +
      (ok
        ? 'every mis-wired install was correctly reported as a failure'
        : `these went UNDETECTED and so prove nothing: ${undetected.join(', ')}`),
  );
  process.exit(ok ? 0 : 1);
}

const failed = results.filter((r) => r.fail > 0);
console.log(
  `\n${failed.length === 0 ? '✅ INSTALL GATE PASSED' : '❌ INSTALL GATE FAILED'} ` +
    `(${String(results.length - failed.length)}/${String(results.length)} scaffolds)`,
);
process.exit(failed.length === 0 ? 0 : 1);
