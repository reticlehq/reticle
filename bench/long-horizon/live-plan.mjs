// A long-horizon plan run on this machine, end to end, with no model: the Harness's plan runner
// (reticle-harness), Reticle's tools on an in-process bridge, and a desktop application joined
// with computer use. It proves the runner, the router, the board and the proofs on real software.
//
// The job crosses two realms: Calculator (desktop, computer use) computes 1234 × 56; the value
// goes on the board; a terminal step writes it to a file; the file is the proof. Every step has
// a proof that the runner checks, and every event goes to a ledger file, so a second run of the
// script goes on from where the first one stopped.
//
//   node bench/long-horizon/live-plan.mjs            # run, or go on with the last run
//   node bench/long-horizon/live-plan.mjs --fresh    # start a new run
//
// Needs: the Accessibility permission, a build of this repository (pnpm build) and of
// ../reticle-harness (npm run build). Calculator comes to the front for a moment.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const harness = join(repo, '../../../../reticle-harness/dist/index.js');
const { Ledger, PlanRunner, fileStore, toolPorts } = await import(harness);
const { MacDriver, connectPeer } = await import(`${repo}adapters/realm/computer-use/dist/index.js`);
const { Bridge } = await import(`${repo}server/dist/portal/bridge/bridge.js`);
const { TOOLS } = await import(`${repo}server/dist/surface/tools/tools.js`);
const { LIVE_CONTROL_TOOLS } = await import(
  `${repo}server/dist/portal/session/live-control-tools.js`
);
const { makeDeps } = await import(`${repo}server/dist/portal/bridge/bridge.test-harness.js`);

const out = join(tmpdir(), 'reticle-long-horizon');
const ledgerPath = join(out, 'ledger.jsonl');
const resultPath = join(out, 'result.txt');
if (process.argv.includes('--fresh')) {
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

// A bridge of its own, on a port the person's daemon does not use.
const token = 'long-horizon-live';
const bridge = new Bridge({ port: 14460, token });
const port = await bridge.ready;
const deps = makeDeps(bridge);
const helper = `${repo}adapters/realm/computer-use/native/mac/build/reticle-ax`;
execFileSync(
  'swiftc',
  ['-O', `${repo}adapters/realm/computer-use/native/mac/reticle-ax.swift`, '-o', helper],
  {
    stdio: 'ignore',
  },
);

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
  projectId: 'long-horizon-live',
  driver: new MacDriver({ helper, app: 'Calculator', pid }),
  now: () => Date.now(),
  foreground: true,
});
await peer.ready;

const tools = [...TOOLS, ...LIVE_CONTROL_TOOLS];
const callTool = async (asked, args) => {
  // The agent's surface folds the session tools into reticle_session; in process they are apart.
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

/** Press a button of Calculator by its name: find its ref, then click it. */
const press = (name) => [
  {
    tool: 'reticle_query',
    args: { role: 'button', name },
    capture: { key: 'button', path: 'elements.0.ref' },
  },
  { tool: 'reticle_act', args: { ref: '{button}', action: 'click' } },
];

const plan = {
  id: 'calculator-to-file',
  goal: 'Compute 1234 × 56 in Calculator and keep the result in a file',
  approved: true,
  steps: [
    {
      id: 'compute',
      intent: 'Compute 1234 × 56 in Calculator',
      target: { app: 'Calculator' },
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
        ...['All Clear', '1', '2', '3', '4', 'Multiply', '5', '6', 'Equals'].flatMap(press),
      ],
      proof: { kind: 'consequence', until: { text: '69,104' } },
    },
    {
      id: 'read-product',
      intent: 'Read the result on the display of Calculator',
      target: { app: 'Calculator' },
      needs: ['compute'],
      writes: ['product'],
      calls: [
        {
          tool: 'reticle_query',
          args: { role: 'text' },
          capture: { key: 'product', path: 'elements.-1.name' },
        },
      ],
      proof: { kind: 'value', key: 'product', pattern: '69,?104' },
    },
    {
      id: 'keep-it',
      intent: 'Write the result to a file',
      target: { command: `printf '%s' '{product}' > '${resultPath}'` },
      needs: ['read-product'],
      reads: ['product'],
      proof: { kind: 'file', path: resultPath, contains: '104' },
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
  // Nothing in this plan asks the person; an unattended run says no to anything that does.
  askPerson: () => Promise.resolve({ approved: false, answer: 'nobody is at the machine' }),
});

const started = Date.now();
let result;
try {
  result = await new PlanRunner(new Ledger(fileStore(ledgerPath), () => Date.now()), ports).run(
    plan,
  );
} finally {
  peer.close();
  await bridge.close?.();
  if (opened) {
    spawnSync('osascript', ['-e', 'tell application "Calculator" to quit']);
  }
}
const steps = [...result.state.steps].map(
  ([id, s]) => `${id}: ${s.status} (tries ${String(s.tries)})`,
);
process.stdout.write(
  `${JSON.stringify({ goalMet: result.goalMet, summary: result.summary, steps, board: Object.fromEntries(result.state.board), ms: Date.now() - started, ledger: ledgerPath }, null, 2)}\n`,
);
process.exit(result.goalMet ? 0 : 1);
