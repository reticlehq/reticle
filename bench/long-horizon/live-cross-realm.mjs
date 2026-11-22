// A plan that crosses three realms on this machine, with values going both ways, and no model:
//
//   browser  read the price and the units from a "sheet" page, from inside the page
//   desktop  clear Calculator, then type {price}*{units}= into it as a person types
//   desktop  read the result from the display
//   browser  write the result back into the page and press Save; the page says "Saved: ..."
//   terminal keep the result in a file
//
// The page is served here and has no SDK: a headless browser from the pool opens it, and the
// reader is put into it (zero install). Calculator is joined with computer use. All of them talk
// to one in-process bridge, and the Harness's plan runner routes each step by `capabilities`.
//
//   node bench/long-horizon/live-cross-realm.mjs
//
// Needs the Accessibility permission, `pnpm build` here, `npm run build` in ../reticle-harness, and
// the browser of the pool (Playwright's Chromium). Calculator comes to the front for a moment.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const { Ledger, PlanRunner, fileStore, toolPorts } = await import(
  join(repo, '../../../../reticle-harness/dist/index.js')
);
const { MacDriver, connectPeer } = await import(`${repo}adapters/realm/computer-use/dist/index.js`);
const { Bridge } = await import(`${repo}server/dist/portal/bridge/bridge.js`);
const { TOOLS } = await import(`${repo}server/dist/surface/tools/tools.js`);
const { LIVE_CONTROL_TOOLS } = await import(
  `${repo}server/dist/portal/session/live-control-tools.js`
);
const { makeDeps } = await import(`${repo}server/dist/portal/bridge/bridge.test-harness.js`);
const { createBrowserPool, readerConnect } = await import(`${repo}server/dist/start-wiring.js`);
const { appendReticleParams } = await import(`${repo}server/dist/index.js`);

const out = join(tmpdir(), 'reticle-cross-realm');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const resultPath = join(out, 'result.txt');

// The "sheet": two numbers, a field for the result, and Save.
const PAGE = `<!doctype html><title>Q3 sheet</title>
<h1>Q3 sheet</h1>
<p>Price: <span data-testid="price">1234</span></p>
<p>Units: <span data-testid="units">56</span></p>
<label>Total <input data-testid="total" aria-label="Total"></label>
<button data-testid="save" onclick="document.querySelector('[data-testid=status]').textContent = 'Saved: ' + document.querySelector('[data-testid=total]').value">Save</button>
<p data-testid="status"></p>`;
const page = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
const PAGE_URL = `http://127.0.0.1:${String(page.address().port)}/`;

const token = 'cross-realm-live';
const bridge = new Bridge({ port: 14461, token });
const port = await bridge.ready;
const deps = makeDeps(bridge);

const pool = createBrowserPool(true, readerConnect(port, token));
const tabId = `tab-sheet-${String(process.pid)}`;
const lease = await pool.acquire(appendReticleParams(PAGE_URL, tabId), { sessionId: tabId });
await lease.injectReader();

const helper = `${repo}adapters/realm/computer-use/native/mac/build/reticle-ax`;
const opened = spawnSync('pgrep', ['-x', 'Calculator']).status !== 0;
if (opened) {
  execFileSync('open', ['-g', '-a', 'Calculator']);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
const pid = Number(
  execFileSync('pgrep', ['-x', 'Calculator'], { encoding: 'utf8' }).trim().split('\n')[0],
);
const peer = connectPeer({
  url: `ws://127.0.0.1:${String(port)}/reticle`,
  token,
  sessionId: 'cu-calculator',
  projectId: 'cross-realm-live',
  driver: new MacDriver({ helper, app: 'Calculator', pid }),
  now: () => Date.now(),
  foreground: true,
});
await peer.ready;
// Both sessions say hello a moment after they connect: the plan routes by what is listed.
for (
  let i = 0;
  i < 100 &&
  (bridge.sessions.get(tabId) === undefined || bridge.sessions.get('cu-calculator') === undefined);
  i += 1
) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const tools = [...TOOLS, ...LIVE_CONTROL_TOOLS];
const callTool = async (asked, args) => {
  const name = asked === 'reticle_session' && args.action === 'list' ? 'reticle_sessions' : asked;
  const tool = tools.find((one) => one.name === name);
  if (tool === undefined) {
    return { ok: false, error: `no tool ${name}` };
  }
  try {
    return await tool.handler(deps, args);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};
const byTestid = (value, key, path) => ({
  tool: 'reticle_query',
  args: { by: 'testid', value },
  capture: { key, path },
});

const plan = {
  id: 'sheet-calculator-sheet',
  goal: 'Multiply the price by the units of the sheet in Calculator, and save the total in the sheet',
  approved: true,
  steps: [
    {
      id: 'read-sheet',
      intent: 'Read the price and the units from the sheet',
      target: { url: PAGE_URL },
      writes: ['price', 'units'],
      calls: [
        byTestid('price', 'price', 'elements.0.text'),
        byTestid('units', 'units', 'elements.0.text'),
      ],
      proof: { kind: 'value', key: 'units', pattern: '^\\d+$' },
    },
    {
      id: 'clear',
      intent: 'Bring Calculator to the front and clear it',
      target: { app: 'Calculator' },
      writes: ['cleared'],
      calls: [
        {
          tool: 'reticle_query',
          args: { role: 'application' },
          capture: { key: 'app', path: 'elements.0.ref' },
        },
        {
          tool: 'reticle_act',
          args: { ref: '{app}', action: 'focus', args: { foreground: true } },
        },
        {
          tool: 'reticle_query',
          args: { role: 'button', name: 'All Clear' },
          capture: { key: 'ac', path: 'elements.0.ref' },
        },
        { tool: 'reticle_act', args: { ref: '{ac}', action: 'click' } },
        {
          tool: 'reticle_query',
          args: { role: 'text' },
          capture: { key: 'cleared', path: 'elements.-1.name' },
        },
      ],
      proof: { kind: 'value', key: 'cleared', pattern: '^0$' },
    },
    {
      id: 'multiply',
      intent: 'Type {price}*{units}= into Calculator',
      target: { app: 'Calculator' },
      needs: ['read-sheet', 'clear'],
      reads: ['price', 'units'],
      writes: ['total'],
      calls: [
        {
          tool: 'reticle_query',
          args: { role: 'application' },
          capture: { key: 'app', path: 'elements.0.ref' },
        },
        {
          tool: 'reticle_act',
          args: {
            ref: '{app}',
            action: 'type',
            args: { text: '{price}*{units}=', foreground: true },
          },
        },
        {
          tool: 'reticle_query',
          args: { role: 'text' },
          capture: { key: 'total', path: 'elements.-1.name' },
        },
      ],
      proof: { kind: 'value', key: 'total', pattern: '^[\\d,]+$' },
    },
    {
      id: 'save-in-sheet',
      intent: 'Write the total into the sheet and press Save',
      target: { url: PAGE_URL },
      needs: ['multiply'],
      reads: ['total'],
      calls: [
        {
          tool: 'reticle_query',
          args: { by: 'testid', value: 'total' },
          capture: { key: 'field', path: 'elements.0.ref' },
        },
        {
          tool: 'reticle_act',
          args: { ref: '{field}', action: 'fill', args: { value: '{total}' } },
        },
        {
          tool: 'reticle_query',
          args: { by: 'testid', value: 'save' },
          capture: { key: 'save', path: 'elements.0.ref' },
        },
        { tool: 'reticle_act', args: { ref: '{save}', action: 'click' } },
      ],
      proof: { kind: 'consequence', until: { text: 'Saved: {total}' } },
    },
    {
      id: 'keep-it',
      intent: 'Keep the total in a file',
      target: { command: `printf '%s' '{total}' > '${resultPath}'` },
      needs: ['save-in-sheet'],
      reads: ['total'],
      proof: { kind: 'file', path: resultPath, contains: '69' },
    },
  ],
};

const ports = toolPorts({
  callTool,
  runCommand: (command) => {
    const ran = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    return Promise.resolve({ code: ran.status ?? 1, output: `${ran.stdout}${ran.stderr}` });
  },
  readFile: (path) => {
    try {
      return Promise.resolve(readFileSync(path, 'utf8'));
    } catch {
      return Promise.resolve(undefined);
    }
  },
  askPerson: () => Promise.resolve({ approved: false, answer: 'nobody is at the machine' }),
});

const started = Date.now();
let result;
const routes = [];
try {
  const catalog = await ports.catalog();
  routes.push(...catalog.map((c) => `${c.realm}: ${c.app ?? c.url ?? c.sessionId}`));
  result = await new PlanRunner(
    new Ledger(fileStore(join(out, 'ledger.jsonl')), () => Date.now()),
    ports,
  ).run(plan);
} finally {
  peer.close();
  await lease.release().catch(() => undefined);
  await pool.close?.().catch(() => undefined);
  await bridge.close?.();
  page.close();
  if (opened) {
    spawnSync('osascript', ['-e', 'tell application "Calculator" to quit']);
  }
}
const steps = [...result.state.steps].map(
  ([id, s]) => `${id}: ${s.status} (tries ${String(s.tries)})${s.why ? ` — ${s.why}` : ''}`,
);
process.stdout.write(
  `${JSON.stringify({ goalMet: result.goalMet, summary: result.summary, sessions: routes, steps, board: Object.fromEntries(result.state.board), ms: Date.now() - started }, null, 2)}\n`,
);
process.exit(result.goalMet ? 0 : 1);
