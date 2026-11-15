// A parallel flow suite on a dev server that compiles the start page for longer than the step
// budget (#2155).
//
// `reticle_verify { action: "flows", parallel: N }` runs each flow on its own pool lease. Replay
// opens the lease on the app, then navigates it to the flow's `startPath`. The page there connects
// Reticle from a module that it imports dynamically, as Inertia's `resolvePageComponent` does, and
// the dev server compiles that module on the first request. While it compiles, the document is
// `complete`. The lease asked only `document.readyState`, read the page as loaded, and replay
// reported "no page was connected" at the 5 s budget. Nothing ran.
//
// Serves its own pages and its own copy of the SDK bundle, so it needs no app from run-ci.sh. The
// server holds the first requests for the page module, as a first compile does, and answers later
// ones at once. The spec asserts the verdict, not a duration (rule 15).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
import {
  start,
  appendReticleParams,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  ProjectStore,
  AnnotationStore,
  createNodeFileSystem,
} from '@reticlehq/server';
const { createBrowserPool, readerConnect } = await import(
  new URL('../../../server/dist/start-wiring.js', import.meta.url).href
);

const SDK_JS = readFileSync(
  new URL('../../../adapters/realm/browser/dist/reticle-inject.js', import.meta.url),
  'utf8',
);

/** Past the 5 s step budget, and well under the 30 s loading cap. */
const COMPILE_MS = 9_000;
const FLOW_NAMES = ['builder-a', 'builder-b'];
const LOST = 'no page was connected';

let pass = 0,
  fail = 0;
const chk = (label, ok, detail = '') => {
  process.stdout.write(`   ${ok ? '✅' : '❌'} ${label}${ok ? '' : '  — ' + detail}\n`);
  ok ? pass++ : fail++;
};

const BRIDGE_WS = `ws://127.0.0.1:${String(TEST_BRIDGE_PORT)}`;

// Both pages import their page module dynamically. The page module connects Reticle.
const HTML = `<!doctype html><html><head><title>slow compile</title></head><body>
<div id="root">loading</div>
<script type="module">
  const page = location.pathname.startsWith('/builder') ? 'builder' : 'home';
  import('/pages/' + page + '.js');
</script></body></html>`;

const BUILDER_UI = `
const root = document.getElementById('root');
root.innerHTML = '<button>go</button>';
root.querySelector('button').addEventListener('click', (e) => { e.target.textContent = 'done'; });`;

const pageModule = (name) =>
  `${SDK_JS}\nReticleSdk.reticle.connect({ url: ${JSON.stringify(BRIDGE_WS)}, token: ${
    globalThis.__TOKEN ?? 'undefined'
  } });\n${name === 'builder' ? BUILDER_UI : ''}`;

/** When the first compile of the builder module ends. Requests before it wait for it. */
let compiledAt;
const builderRequests = [];

const app = createServer((req, res) => {
  const route = new URL(req.url ?? '/', 'http://x').pathname;
  const send = (body) => {
    res.setHeader('content-type', 'text/javascript');
    res.end(body);
  };
  if (route === '/pages/home.js') {
    send(pageModule('home'));
    return;
  }
  if (route === '/pages/builder.js') {
    compiledAt ??= Date.now() + COMPILE_MS;
    builderRequests.push(Date.now());
    setTimeout(() => send(pageModule('builder')), Math.max(0, compiledAt - Date.now()));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(HTML);
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${String(app.address().port)}`;

process.stdout.write('\n=== PARALLEL FLOWS: a start page that the dev server compiles slowly ===\n');

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
globalThis.__TOKEN = server.token === undefined ? 'undefined' : JSON.stringify(server.token);
const pool = createBrowserPool(true, readerConnect(TEST_BRIDGE_PORT, server.token));
const reticleRoot = path.join(os.tmpdir(), `reticle-slow-start-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const flows = new FlowStore(fsp, reticleRoot, { now });
const deps = {
  sessions: server.bridge.sessions,
  pool,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  flows,
  project: new ProjectStore(fsp, reticleRoot, { now }),
  annotations: new AnnotationStore(),
  fs: fsp,
  reticleRoot,
  now,
};
const sid = `slow-start-${process.pid}`;

let anchor;
try {
  for (const name of FLOW_NAMES) {
    await flows.saveFlow({
      version: 2,
      name,
      createdAt: 0,
      startPath: '/builder/',
      steps: [
        {
          tool: 'reticle_act',
          // A role anchor: only a testid or a component lets replay start on another page.
          anchor: { kind: 'role', role: 'button', name: 'go' },
          action: 'click',
          expect: { kind: 'text', contains: 'done' },
        },
      ],
    });
  }
  // The tab the agent drives. The suite takes the app's address from it.
  anchor = await pool.acquire(appendReticleParams(`${APP}/`, sid), { sessionId: sid });
  let connected = false;
  for (let i = 0; i < 100 && !connected; i += 1) {
    connected = server.bridge.sessions.get(sid) !== undefined;
    if (!connected) await new Promise((r) => setTimeout(r, 100));
  }
  chk('the home page connects under the lease id', connected);

  // The call of the report: the public tool, as an agent makes it.
  const verify = TOOLS.find((t) => t.name === 'reticle_verify');
  const suite = await verify.handler(deps, {
    sessionId: sid,
    action: 'flows',
    parallel: FLOW_NAMES.length,
  });
  const reasons = (suite.unverifiable ?? []).map((u) => u.reason).join(' | ');
  process.stdout.write(
    `   suite: status=${String(suite.status)} isolation=${String(suite.isolation)} ` +
      `passed=${String(suite.passed)}/${String(suite.total)}\n`,
  );
  chk('each flow ran on its own lease', 'per-flow-lease' === suite.isolation, String(suite.isolation));
  chk(
    'the server compiled the start page past the step budget',
    builderRequests.length > 0,
    'no request for the builder module',
  );
  chk('no flow reports that no page was connected', !reasons.includes(LOST), reasons.slice(0, 400));
  chk(
    'every flow passed on the slow start page',
    'pass' === suite.status && FLOW_NAMES.length === suite.passed,
    `status=${String(suite.status)} passed=${String(suite.passed)} ${reasons.slice(0, 300)}`,
  );
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await anchor?.release().catch(() => undefined);
  await pool.shutdown();
  await server.close();
  app.close();
}

process.stdout.write(
  `\n${fail === 0 ? '✅' : '❌'} SLOW START PAGE ON A LEASE (${String(pass)} passed, ${String(fail)} failed)\n`,
);
process.exit(fail === 0 ? 0 : 1);
