// Deterministic regression injector. Each regression is a set of exact string
// replacements in tracked source files; revert() restores via `git checkout --`.
// Only touches apps/demo/src + apps/api (clean files); never the marketing changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = {
  store: `${ROOT}/apps/demo/src/store/store.ts`,
  modal: `${ROOT}/apps/demo/src/components/NewDeployModal.tsx`,
  overview: `${ROOT}/apps/demo/src/views/Overview.tsx`,
  diagnostics: `${ROOT}/apps/demo/src/views/Diagnostics.tsx`,
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
      // Empty service no longer blocked: guard removed + submit enabled.
      replaceOnce(
        F.modal,
        '    if (service.trim().length === 0) return;\n',
        '    /* validation guard removed (regression) */\n',
      );
      replaceOnce(F.modal, 'disabled={service.trim().length === 0}', 'disabled={false}');
    },
  },
  'cross-component-regression': {
    files: [F.store],
    apply() {
      // Filter input (component A) silently stops affecting the deploy table (component B).
      replaceOnce(
        F.store,
        '    set({ filter: { ...get().filter, ...patch } });',
        '    set({ filter: { ...get().filter } }); /* patch dropped (regression) */',
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
      // Add a fault button that calls a hanging endpoint (added to api/server.mjs separately).
      replaceOnce(
        F.diagnostics,
        "  { kind: '404', testid: 'fault-404', label: '404 Not Found', desc: 'GET /api/broken/404' },",
        "  { kind: '404', testid: 'fault-404', label: '404 Not Found', desc: 'GET /api/broken/404' },\n  { kind: 'timeout', testid: 'fault-timeout', label: 'Timeout', desc: 'GET /api/broken/timeout (hangs)' },",
      );
    },
  },
};

export function listRegressions() {
  return Object.keys(REGRESSIONS);
}

export function inject(id) {
  const r = REGRESSIONS[id];
  if (!r) throw new Error(`unknown regression ${id}`);
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

if (process.argv[2] === '--revert-all') {
  revertAll();
  console.log('reverted all');
}
if (process.argv[2] === '--list') {
  console.log(listRegressions().join('\n'));
}
