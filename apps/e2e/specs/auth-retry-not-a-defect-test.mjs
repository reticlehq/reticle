// A 401 the app recovered from is not two defects.
//
// This is the false-RED class, and it is the expensive direction. A field reporter's
// `reticle_assert` returned `pass: true` and Reticle overrode it to `verified: "no",
// verifiedReason: "contradicted"` with two findings, both describing the app working correctly:
//
//   - `ui-advanced-request-failed`: "POST .../command -> 401"
//   - `duplicate-request`:          "the same write fired 2 times"
//
// `reticle_network` showed the exact shape: one 401 in 51ms with a 35-byte body, immediately
// followed by one 200 carrying the real result. Nothing fired twice in effect — the first attempt
// was rejected before doing any work — and the UI advancing was right, not contradictory.
//
// Why this matters more than a missed bug, in the reporter's words: it taught them, inside a single
// session, that a `contradicted` verdict may be noise worth arguing with. That is precisely the
// reflex this product exists to suppress, so a manufactured red costs more here than a missed one.
//
// The fixture keeps the honest shape rather than simulating it: a real 401 on the wire, a real
// refresh, and a real retry that succeeds — all from one click.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
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
const server = await start({ port: 4400, mcp: false });
const reticleRoot = path.join(os.tmpdir(), `reticle-auth-retry-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
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
  what: 'the bench-app session for the expiring-token fixture',
});

console.log('\n=== AUTH RETRY: a 401 the app recovered from is not a defect ===');

const refOf = async (by, value) => {
  for (let i = 0; i < 40; i++) {
    const r = (await T('reticle_query', { by, value })).elements?.[0]?.ref;
    if (r) return r;
    await sleep(150);
  }
  return undefined;
};

const loginBtn = await refOf('testid', 'login-submit');
if (loginBtn !== undefined) {
  await T('reticle_act_and_wait', {
    ref: loginBtn,
    action: 'click',
    until: { kind: 'signal', name: 'auth:granted' },
    timeout_ms: 5000,
  });
}
const navRef = await refOf('testid', 'nav-expiring-auth');
if (navRef !== undefined) {
  await T('reticle_act_and_wait', {
    ref: navRef,
    action: 'click',
    until: { kind: 'signal', name: 'nav:changed' },
    timeout_ms: 5000,
  });
}

const write = await refOf('testid', 'expiring-auth-write');
if (write === undefined) {
  chk('the expiring-token fixture is reachable', false, 'no expiring-auth-write testid');
} else {
  // One click produces: POST -> 401, POST /auth/refresh -> 200, POST -> 200.
  const verdict = await T('reticle_act_and_wait', {
    ref: write,
    action: 'click',
    until: { kind: 'net', urlContains: '/api/expiring-write', method: 'POST', status: 200 },
    timeout_ms: 10000,
  });

  const contradictions = verdict.contradictions ?? [];
  const kinds = contradictions.map((c) => String(c.kind ?? ''));

  chk(
    'the retry that succeeded is what the verdict reports',
    verdict.verified === 'yes',
    `verified=${String(verdict.verified)} reason=${String(verdict.verifiedReason ?? '')}`,
  );
  // The two findings the field report received, named individually so a regression says WHICH.
  chk(
    'a 401 superseded by an identical 2xx is not reported as a failed request',
    !kinds.includes('ui-advanced-request-failed'),
    `kinds=${JSON.stringify(kinds)}`,
  );
  chk(
    'a retry-once after a rejected attempt is not reported as a duplicate write',
    !kinds.includes('duplicate-request'),
    `kinds=${JSON.stringify(kinds)}`,
  );
  // Guards the guard: if the fixture stops producing a 401 at all, the three checks above pass for
  // free and this spec becomes decoration. The 401 must actually be on the wire.
  const net = await T('reticle_network', { urlContains: '/api/expiring-write', bodies: false });
  const statuses = (net.calls ?? net.requests ?? []).map((c) => c.status);
  chk(
    'the fixture really did produce a 401 followed by a 200 — otherwise this proves nothing',
    statuses.includes(401) && statuses.includes(200),
    `statuses=${JSON.stringify(statuses)}`,
  );
}

await b.close();
console.log(`\n${fail === 0 ? '✅ AUTH RETRY VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
