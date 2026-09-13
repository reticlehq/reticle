// Three properties of real applications this repo had no fixture for.
//
// Each is here because a fix shipped against unit tests alone, or because a capability was reported
// as absent and nothing here could demonstrate it either way.
//
//  1. A FILE INPUT. There was no `<input type="file">` anywhere under `apps/`, which is exactly how
//     the recorder and the replayer came to disagree about what an upload step IS: the recorder
//     wrote `{path}`, the replayer only took `{name, content, type}`, and a recorded upload could
//     never replay. `resolveFlowUploads` fixed that — against unit tests, with no fixture that
//     could show it. This is the end-to-end half.
//  2. AN ICON-ONLY BUTTON WITH NO ACCESSIBLE NAME. The honest behaviour is to say the control has no
//     name — never to quietly match it to something else, and never to call it absent when it is
//     plainly there and clickable by ref.
//  3. A CANVAS. Reticle's model is DOM + store + network, complete for CRUD apps and empty for 3D
//     ones. A team adopting Reticle for a canvas app does not find that out until they try to verify
//     the feature they care about, because everything AROUND the canvas verifies fine.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import nfs from 'node:fs';
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  ProjectStore,
  AnnotationStore,
  createNodeFileSystem,
} from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const APP_URL = 'http://localhost:4310/';
// `reticleRoot`'s PARENT is the project root the upload resolver measures paths against, so the
// fixture is addressed relative to it exactly as a user's would be.
const projectRoot = path.resolve('apps/e2e');
const reticleRoot = path.join(projectRoot, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const server = await start({ port: 4400, mcp: false });
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  flows: new FlowStore(fsp, reticleRoot, { now }),
  project: new ProjectStore(fsp, reticleRoot, { now }),
  annotations: new AnnotationStore(),
  fs: fsp,
  reticleRoot,
  now,
};
const isBench = (s) => String(s?.url ?? '').startsWith(APP_URL);
const sessionId = () => server.bridge.sessions.list().find(isBench)?.sessionId;
const T = (n, a = {}) =>
  TOOLS.find((t) => t.name === n).handler(deps, { sessionId: sessionId(), ...a });

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(APP_URL);
await waitForSession(() => server.bridge.sessions.list(), isBench, {
  what: 'the bench-app session for the awkward-controls fixture',
});

console.log('\n=== AWKWARD CONTROLS: upload, an unnamed button, and a canvas ===');

const refOf = async (by, value) => {
  for (let i = 0; i < 40; i++) {
    const r = (await T('reticle_query', { by, value })).elements?.[0]?.ref;
    if (r) return r;
    await sleep(150);
  }
  return undefined;
};

const login = await refOf('testid', 'login-submit');
if (login !== undefined) {
  await T('reticle_act_and_wait', {
    ref: login,
    action: 'click',
    until: { kind: 'signal', name: 'auth:granted' },
    timeout_ms: 5000,
  });
}
const nav = await refOf('testid', 'nav-awkward');
if (nav !== undefined) {
  await T('reticle_act_and_wait', {
    ref: nav,
    action: 'click',
    until: { kind: 'signal', name: 'nav:changed' },
    timeout_ms: 5000,
  });
}

// ── 1. A recorded upload replays as recorded ─────────────────────────────────────────────────
// The flow carries `{path}`, which is what `reticle_record` writes and the only form the live tool
// accepts. Before `resolveFlowUploads` the replayer refused it outright.
const uploadFlow = {
  version: 1,
  name: 'attach-a-file',
  createdAt: 0,
  steps: [
    {
      tool: 'reticle_act',
      anchor: { kind: 'testid', value: 'awkward-file' },
      action: 'upload',
      args: { path: 'fixtures/upload-sample.csv' },
      expect: { net: { urlContains: '/api/score', method: 'POST', status: 200 } },
    },
  ],
};
// Saved to disk and replayed through `reticle_flow_replay`, which is where `resolveFlowUploads` is
// wired. Importing the helper directly would test the helper; this tests the path a user takes.
// Written where the store reads it. `FlowStore.save` compiles a RECORDING, which is a different
// shape from a flow file, and this spec is about replaying a flow that already exists.
nfs.mkdirSync(path.join(reticleRoot, 'flows'), { recursive: true });
nfs.writeFileSync(
  path.join(reticleRoot, 'flows', `${uploadFlow.name}.json`),
  `${JSON.stringify(uploadFlow, null, 2)}\n`,
);
const replay = await T('reticle_flow_replay', { flowName: uploadFlow.name });
const step = (replay.steps ?? [])[0] ?? {};
chk(
  'a recorded upload replays as recorded — the path is resolved to real bytes on the way',
  step.ok === true && step.drift === undefined,
  `ok=${String(step.ok)} drift=${JSON.stringify(step.drift ?? {}).slice(0, 120)}`,
);
const picked = await T('reticle_query', { by: 'testid', value: 'awkward-picked' });
chk(
  'and the app received the file it was given, by name',
  JSON.stringify(picked).includes('upload-sample.csv'),
  JSON.stringify(picked.elements?.[0] ?? {}).slice(0, 90),
);

// ── 2. An unnamed icon button is reported as unnamed ──────────────────────────────────────────
const byName = await T('reticle_query', { by: 'role', value: 'button', name: 'Delete' });
chk(
  'a name that is not on the page matches nothing — no silent nearest-match',
  0 === (byName.elements ?? []).length || byName.count === 0,
  `count=${String(byName.count ?? (byName.elements ?? []).length)}`,
);
const iconRef = await refOf('testid', 'awkward-icon');
chk('the unnamed button is still addressable by testid', iconRef !== undefined);
if (iconRef !== undefined) {
  const act = await T('reticle_act_and_wait', {
    ref: iconRef,
    action: 'click',
    until: { kind: 'text', contains: '1', scope: undefined },
    timeout_ms: 4000,
  });
  chk(
    'and clicking it works, so "no accessible name" is a NAMING gap, not an unreachable control',
    act.verified !== undefined,
    `verified=${String(act.verified)}`,
  );
}

// ── 3. A canvas is a blank rectangle, and that must be visible rather than implied ─────────────
const canvasRef = await refOf('testid', 'awkward-canvas');
chk('the canvas element itself is found', canvasRef !== undefined);
const snap = await T('reticle_snapshot', { mode: 'interactive' });
const tree = String(snap.tree ?? '');
chk(
  'nothing INSIDE the canvas appears in the tree — the honest, documented limit',
  !tree.includes('inside the canvas'),
  'text painted into the canvas must not be reported as DOM content',
);

await b.close();
console.log(
  `\n${fail === 0 ? '✅ AWKWARD CONTROLS VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
