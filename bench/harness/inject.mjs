// Deterministic regression injector. Each regression is a set of exact string
// replacements in tracked source files; revert() restores via `git checkout --`.
// Only touches the bench fixture app's src (clean files); never the marketing changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// One source of truth for the fixture app the benches boot (bench-all.mjs boots @reticlehq/bench-app).
// Keep this in sync with bench-all's fixture so the injector and the runner never target different
// apps again.
const FIXTURE_APP = `${ROOT}/apps/bench-app`;
const F = {
  store: `${FIXTURE_APP}/src/store/store.ts`,
  modal: `${FIXTURE_APP}/src/components/NewDeployModal.tsx`,
  overview: `${FIXTURE_APP}/src/views/Overview.tsx`,
  diagnostics: `${FIXTURE_APP}/src/views/Diagnostics.tsx`,
};

function replaceOnce(file, from, to) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(from)) throw new Error(`inject: anchor not found in ${file}:\n${from}`);
  writeFileSync(file, src.replace(from, to));
}

// regression id -> { files:[...], apply() }
const REGRESSIONS = {
  'silent-dom-regression': {
    files: [F.overview],
    apply() {
      // Silently drop one KPI card — DOM node disappears, layout still looks fine.
      replaceOnce(F.overview, '{kpis.map((k) => {', '{kpis.slice(0, -1).map((k) => {');
    },
  },
  'signal-contract-violation': {
    files: [F.store],
    apply() {
      // Emit the WRONG domain signal on navigation (plausible copy-paste bug): the view still switches
      // (DOM correct) and A signal fires, but NAV_CHANGED specifically never does — the contract is
      // silently broken, invisible to DOM/network/console. Comment-free so source-reading can't cheat:
      // the marker is real-looking code, not a self-label.
      replaceOnce(
        F.store,
        '    emit(Sig.NAV_CHANGED, { view });',
        '    emit(Sig.FILTER_CHANGED, { view });',
      );
    },
  },
  'route-transition-break': {
    files: [F.store],
    apply() {
      // Navigating to 'compose' silently does nothing — view never changes.
      replaceOnce(
        F.store,
        '  setView: (view) => {\n    set({ view });',
        "  setView: (view) => {\n    set({ view: view === 'compose' ? get().view : view });",
      );
    },
  },
  'missing-modal': {
    files: [F.store],
    apply() {
      // The new-deploy button can never open the modal.
      replaceOnce(
        F.store,
        '  setNewDeploy: (newDeployOpen) => {\n    set({ newDeployOpen });',
        '  setNewDeploy: (newDeployOpen) => {\n    set({ newDeployOpen: false });',
      );
    },
  },
  'broken-form-validation': {
    files: [F.modal],
    apply() {
      // Empty service no longer blocked: the guard checks the raw (un-trimmed) length so a whitespace
      // or empty-after-trim service slips through, and submit is enabled. Comment-free (an off-by-a-
      // method bug), so source-reading gets no self-labeled giveaway.
      // Anchors are in YODA form because the repo's own `yoda` lint rule rewrote the fixture that way.
      // They were not updated with it, so the injector stopped finding them and this scenario silently
      // left the comparison — see the drift note above replaceOnce.
      replaceOnce(
        F.modal,
        '    if (0 === service.trim().length) return;\n',
        '    if (-1 === service.length) return;\n',
      );
      replaceOnce(F.modal, 'disabled={0 === service.trim().length}', 'disabled={false}');
    },
  },
  'cross-component-regression': {
    files: [F.store],
    apply() {
      // Filter input (component A) silently stops affecting the deploy table (component B): the setter
      // re-assigns the current filter and drops the incoming patch. Comment-free (a plausible no-op
      // bug), so source-reading gets no giveaway — the marker is real-looking code, not a self-label.
      replaceOnce(
        F.store,
        '    set({ filter: { ...get().filter, ...patch } });',
        '    set({ filter: get().filter });',
      );
    },
  },
  'layout-shift': {
    files: [F.overview],
    apply() {
      // Grid columns change — pure CSS/CLS regression; a11y tree is unchanged.
      replaceOnce(
        F.overview,
        "gridTemplateColumns: '1.6fr 1fr'",
        "gridTemplateColumns: '1fr 1fr 1fr'",
      );
    },
  },
  'network-timeout': {
    files: [F.diagnostics],
    apply() {
      // Add a fault button that calls the hanging endpoint apps/api/server.mjs serves.
      replaceOnce(
        F.diagnostics,
        "  { kind: '404', testid: 'fault-404', label: '404 Not Found', desc: 'GET /api/broken/404' },",
        "  { kind: '404', testid: 'fault-404', label: '404 Not Found', desc: 'GET /api/broken/404' },\n  { kind: 'timeout', testid: 'fault-timeout', label: 'Timeout', desc: 'GET /api/broken/timeout (hangs)' },",
      );
    },
  },
};

// The unique marker string each regression injects. A bug is FIXED iff its marker is gone from its
// files — sound for any fix (revert or rewrite), since removing the buggy code is necessary to fix it.
// Used by the fix-loop ablation's deterministic re-check (bench/fix-loop).
export const INJECTION_SIGNATURES = {
  'silent-dom-regression': ['kpis.slice(0, -1)'],
  'signal-contract-violation': ['emit(Sig.FILTER_CHANGED, { view })'],
  'route-transition-break': ["view === 'compose' ? get().view : view"],
  'missing-modal': ['set({ newDeployOpen: false })'],
  'broken-form-validation': ['if (-1 === service.length) return;', 'disabled={false}'],
  'cross-component-regression': ['set({ filter: get().filter })'],
  'layout-shift': ["gridTemplateColumns: '1fr 1fr 1fr'"],
  'network-timeout': ['fault-timeout'],
};

export function listRegressions() {
  return Object.keys(REGRESSIONS);
}

/** The marker strings for a regression (empty if none registered — that bug isn't fix-loop-checkable). */
export function signaturesOf(id) {
  return INJECTION_SIGNATURES[id] ?? [];
}

/** The source files a regression touches. */
/** Every tracked file this module rewrites — the blast radius of a `git checkout --`. */
const ANCHOR_FILES = [...new Set(Object.values(REGRESSIONS).flatMap((r) => r.files))];

function isDirty(file) {
  for (const args of [
    ['diff', '--quiet', '--', file],
    ['diff', '--cached', '--quiet', '--', file],
  ]) {
    try {
      execFileSync('git', ['-C', ROOT, ...args], { stdio: 'ignore' });
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Refuse to run if an anchor file carries uncommitted work.
 *
 * `revert()` restores with `git checkout --`, which HARD-DISCARDS. Anything uncommitted in these
 * four files was silently destroyed by running the benchmark — no prompt, no stash, and nothing in
 * the reflog to recover from, because the work was never committed. Easy to hit: edit the bench app
 * to reproduce something, run the benchmark to measure it, lose the edit. Worse with parallel agent
 * sessions, which share one checkout.
 *
 * Refuse rather than destroy. Deliberately NOT `git stash` + restore: a run killed partway through
 * would leave the user's work somewhere they do not know to look, which is a worse failure than the
 * one being fixed.
 *
 * Latched, because after the first injection these files are dirty BY DESIGN and re-checking would
 * refuse the harness's own work. `revertAll()` is intentionally left ungated — it is the recovery
 * path when a crashed run leaves an injection behind, and gating it would strand the user.
 */
let anchorsChecked = false;
export function assertAnchorsClean() {
  if (anchorsChecked) return;
  anchorsChecked = true;
  const dirty = ANCHOR_FILES.filter(isDirty).map((f) => f.slice(ROOT.length + 1));
  if (0 === dirty.length) return;
  throw new Error(
    `inject: refusing to run — the benchmark reverts these files with \`git checkout --\`, which ` +
      `would discard your uncommitted work:\n` +
      dirty.map((f) => `  ${f}`).join('\n') +
      `\n\nCommit or stash them first. If a previous run crashed and left a regression injected, ` +
      `run \`node bench/harness/inject.mjs --revert-all\` to clear it.`,
  );
}

export function filesOf(id) {
  const r = REGRESSIONS[id];
  if (!r) throw new Error(`unknown regression ${id}`);
  return r.files;
}

export function inject(id) {
  const r = REGRESSIONS[id];
  if (!r) throw new Error(`unknown regression ${id}`);
  assertAnchorsClean();
  r.apply();
  return r.files;
}

export function revert(id) {
  const r = REGRESSIONS[id];
  if (!r) throw new Error(`unknown regression ${id}`);
  for (const f of r.files)
    execFileSync('git', ['-C', ROOT, 'checkout', '--', f], { stdio: 'ignore' });
}

export function revertAll() {
  const files = [...new Set(Object.values(REGRESSIONS).flatMap((r) => r.files))];
  for (const f of files) {
    try {
      execFileSync('git', ['-C', ROOT, 'checkout', '--', f], { stdio: 'ignore' });
    } catch {
      /* noop */
    }
  }
}

/**
 * Do all the anchors still resolve?
 *
 * Anchor drift is SILENT and it flatters us. The injector throws, the observation harness records
 * `NOT MEASURED`, the scenario leaves the comparison, and the catch-rate is then computed over
 * whatever survived — so the headline stays perfect while coverage shrinks. That is exactly how
 * `broken-form-validation` vanished: the repo's own `yoda` lint rule rewrote the fixture from
 * `service.trim().length === 0` to `0 === service.trim().length`, these anchors were not updated with
 * it, and three tools' worth of cells silently went missing with nothing red anywhere.
 *
 * Injects each regression and reverts it, reporting the ones that no longer apply. Cheap enough to
 * run before a measured pass, which is the point: a benchmark that cannot inject its bugs is not
 * measuring anything, and it must say so LOUDLY rather than average itself over the survivors.
 */
export function verifyAnchors() {
  // Up front, so the preflight refuses before it touches anything rather than on the first apply().
  assertAnchorsClean();
  const broken = [];
  for (const id of Object.keys(REGRESSIONS)) {
    try {
      inject(id);
    } catch (e) {
      broken.push({ id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      revert(id);
    }
  }
  return broken;
}

if ('--verify-anchors' === process.argv[2]) {
  // A refusal is a message to a human, not a crash: print the sentence, not a stack trace.
  let broken;
  try {
    broken = verifyAnchors();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  for (const b of broken) console.error(`DRIFTED ${b.id}: ${b.error.split('\n')[0]}`);
  console.log(
    0 === broken.length
      ? `anchors ok — all ${String(Object.keys(REGRESSIONS).length)} regressions still apply`
      : `${String(broken.length)} of ${String(Object.keys(REGRESSIONS).length)} regressions no longer apply`,
  );
  process.exit(0 === broken.length ? 0 : 1);
}
if ('--revert-all' === process.argv[2]) {
  revertAll();
  console.log('reverted all');
}
if ('--list' === process.argv[2]) {
  console.log(listRegressions().join('\n'));
}
