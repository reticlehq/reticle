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
const { Ledger, PlanRunner, driveStepWith, fileStore, openAiDriver, toolPorts } = await import(
  join(repo, '../../../../reticle-harness/dist/index.js')
);
const { MacDriver, connectPeer } = await import(`${repo}adapters/realm/computer/dist/index.js`);
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

const helper = `${repo}adapters/realm/computer/native/mac/build/reticle-ax`;
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
  // The agent's surface folds these into reticle_session; in process they are apart.
  const folded = { list: 'reticle_sessions', board: 'reticle_board' };
  const name = asked === 'reticle_session' ? (folded[args.action] ?? asked) : asked;
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

// With --model=<name>, the two steps in the page have no calls: an OpenAI model drives them with
// Reticle's tools, from their intent. Their proofs are the same, so its word counts for nothing.
const MODEL = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
if (MODEL !== undefined && !process.env.OPENAI_API_KEY) {
  process.stdout.write('--model needs OPENAI_API_KEY: run with node --env-file=.env\n');
  process.exit(2);
}
const MODEL_TOOLS = [
  {
    name: 'reticle_snapshot',
    description: 'Read the page as lines, each element with its role, its name and its ref.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reticle_query',
    description:
      'Find elements. by: role, text, label or testid; value: what to look for. Gives each with its ref and its text.',
    inputSchema: {
      type: 'object',
      properties: {
        by: { type: 'string', enum: ['role', 'text', 'label', 'testid'] },
        value: { type: 'string' },
      },
      required: ['by', 'value'],
    },
  },
  {
    name: 'reticle_act',
    description:
      'Act on an element by its ref. action: click, fill (args.value is the text), press (args.text is the key).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        action: { type: 'string', enum: ['click', 'fill', 'press'] },
        args: {
          type: 'object',
          properties: { value: { type: 'string' }, text: { type: 'string' } },
        },
      },
      required: ['ref', 'action'],
    },
  },
];
const MODEL_SYSTEM =
  'You do one step of a plan in a web page, with Reticle tools. Read the page first, then act. Give each value the step asks for with plan_value, exactly as the page shows it. Call finish with goalMet true when the step is done, or false with the reason when it cannot be done.';

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

if (MODEL !== undefined) {
  for (const step of plan.steps) {
    if (step.target.url !== undefined) {
      delete step.calls;
    }
  }
}
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
  ...(MODEL === undefined
    ? {}
    : {
        drive: driveStepWith({
          driver: openAiDriver({ apiKey: process.env.OPENAI_API_KEY, model: MODEL }),
          callTool,
          tools: MODEL_TOOLS,
          system: MODEL_SYSTEM,
          maxSteps: 12,
        }),
      }),
});

const started = Date.now();
let result;
let shared = [];
const routes = [];
try {
  const catalog = await ports.catalog();
  routes.push(...catalog.map((c) => `${c.realm}: ${c.app ?? c.url ?? c.sessionId}`));
  result = await new PlanRunner(
    new Ledger(fileStore(join(out, 'ledger.jsonl')), () => Date.now()),
    ports,
  ).run(plan);
  // What the plan found is on the board of the bridge, for any other agent on it.
  shared =
    (await callTool('reticle_session', { action: 'board' })).entries?.map(
      (e) => `${e.key}=${e.value} (from ${e.from ?? '?'})`,
    ) ?? [];
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
  `${JSON.stringify({ goalMet: result.goalMet, summary: result.summary, sessions: routes, steps, bridgeBoard: shared, board: Object.fromEntries(result.state.board), ...(MODEL === undefined ? {} : { model: MODEL }), ms: Date.now() - started }, null, 2)}\n`,
);
process.exit(result.goalMet ? 0 : 1);
