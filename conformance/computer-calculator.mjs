// A whole task on an application that Reticle did not write, through a real bridge and the tools
// an agent has: the system Calculator works out 7 × 6. Each press is proved by what the display
// then shows. The task is recorded and saved, Calculator is closed and opened again, and the
// saved flow replays with no model. It holds when the display says 42 after the replay too.
//
//   node conformance/computer-calculator.mjs
//
// macOS, with the Accessibility permission. Build the repository first. Not a gate: it opens
// Calculator on the screen. It does not run when Calculator is open already: that window
// belongs to the person. Calculator writes no file and has no account.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { MacDriver, connectPeer } from '../adapters/realm/computer/dist/index.js';
import { FINISH_TOOL } from '../server/dist/features/harness/harness.js';
import { Bridge } from '../server/dist/portal/bridge/bridge.js';
import { exploreApp } from '../server/dist/surface/tools/harness-explore.js';
import { callTool, makeDeps, waitUntil } from '../server/dist/portal/bridge/bridge.test-harness.js';

const APP = 'Calculator';
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if ('darwin' !== process.platform || 0 !== pidOf()) {
  console.error('computer-calculator: not macOS, or Calculator is open already. Nothing was run.');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const helper = `${root}adapters/realm/computer/native/mac/build/reticle-ax`;
const TOKEN = 'calculator';
const bridge = new Bridge({ port: 0, token: TOKEN });
const port = await bridge.ready;
const deps = makeDeps(bridge);

/** Starts Calculator and joins it. The answer closes both. */
async function open() {
  execFileSync('open', ['-a', APP]);
  let pid = 0;
  for (let tries = 0; tries < 40 && 0 === pid; tries += 1) {
    await sleep(250);
    pid = pidOf();
  }
  assert.ok(0 !== pid, 'Calculator did not start');
  const peer = connectPeer({
    url: `ws://localhost:${String(port)}/reticle`,
    token: TOKEN,
    sessionId: 'cu-calculator',
    projectId: 'cu-calculator',
    driver: new MacDriver({ helper, app: APP, pid }),
    now: () => Date.now(),
  });
  await peer.ready;
  await waitUntil(() => 1 === bridge.sessions.count());
  // The window has its buttons some time after the process is there.
  for (let tries = 0; tries < 40; tries += 1) {
    if ((await callTool(deps, 'reticle_snapshot', {})).tree.includes('button "Equals"')) {
      break;
    }
    await sleep(250);
  }
  return async () => {
    peer.close();
    process.kill(pid);
    await waitUntil(() => 0 === bridge.sessions.count());
    await sleep(1500);
  };
}

/** What the display says: the digits of the text in the window. */
const display = (tree) =>
  [...tree.matchAll(/- text "([^"]*)"/g)].map((m) => m[1].replace(/[^\d]/g, '')).join(' ');

// Each press, and what a text of the display must then hold. The query names the role: the
// button "7" has the text 7 too, and a check that it is there is true before the press.
const STEPS = [
  ['7', '7'],
  ['Multiply', '×'],
  ['6', '6'],
  ['Equals', '42'],
];

let close = await open();
try {
  const page = await callTool(deps, 'reticle_snapshot', {});
  await callTool(deps, 'reticle_record', { action: 'start' });
  for (const [name, shows] of STEPS) {
    const ref = new RegExp(`- button "${name}" \\(ref=(e\\d+)\\)`).exec(page.tree)?.[1];
    assert.ok(ref, `no button named ${name}`);
    const proved = await callTool(deps, 'reticle_act_and_wait', {
      ref,
      action: 'click',
      timeout_ms: 3000,
      until: { kind: 'element', query: { role: 'text', text: shows }, state: 'visible' },
    });
    if (process.argv.includes('--show')) {
      console.error(
        name,
        JSON.stringify({
          verified: proved.verified,
          because: proved.because,
          reason: proved.verifiedReason,
        }),
      );
    } else {
      assert.equal(proved.verified, 'yes', `press ${name}: ${String(proved.because)}`);
    }
  }
  assert.ok(display((await callTool(deps, 'reticle_snapshot', {})).tree).includes('42'));
  const recorded = await callTool(deps, 'reticle_record', { action: 'stop' });
  await callTool(deps, 'reticle_flow_save', { flowName: recorded.recordingName });

  // A new Calculator: nothing of the first run is left in it.
  await close();
  close = await open();
  assert.ok(!display((await callTool(deps, 'reticle_snapshot', {})).tree).includes('42'));
  const started = Date.now();
  const replayed = await callTool(deps, 'reticle_flow_replay', {
    flowName: recorded.recordingName,
  });
  const took = Date.now() - started;
  assert.equal(replayed.status, 'ok', JSON.stringify(replayed.steps));
  assert.ok(display((await callTool(deps, 'reticle_snapshot', {})).tree).includes('42'));
  console.error(
    `computer calculator: ${String(STEPS.length)} presses proved, and the saved flow replayed in ${String(took)} ms with no model`,
  );
} finally {
  await close();
}

/**
 * The Harness drives Calculator. The model is a script here, so the run costs nothing and is the
 * same each time. What is checked is the Harness on an application that Reticle did not write:
 * the prompt it gives, the tools as it calls them, and the verdict of each press.
 */
try {
  close = await open();
  const turns = [
    () => [{ id: 'look', name: 'reticle_snapshot', args: {} }],
    () => [{ id: 'record', name: 'reticle_record', args: { action: 'start' } }],
    ...STEPS.map(([name, shows], at) => (tree) => [
      {
        id: `press-${String(at)}`,
        name: 'reticle_act_and_wait',
        args: {
          ref: new RegExp(`- button "${name}" \\(ref=(e\\d+)\\)`).exec(tree)?.[1],
          action: 'click',
          timeout_ms: 3000,
          until: { kind: 'element', query: { role: 'text', text: shows }, state: 'visible' },
        },
      },
    ]),
    () => [{ id: 'save', name: 'reticle_flow_save', args: { flowName: 'default' } }],
    () => [{ id: 'end', name: FINISH_TOOL.name, args: { summary: '42', goalMet: true } }],
  ];
  const systems = [];
  let tree = '';
  const scripted = {
    turn: (input) => {
      systems.push(input.system);
      const last = JSON.stringify(input.history.at(-1) ?? {});
      tree = /- application|- window/.test(last)
        ? last.replaceAll('\\"', '"').replaceAll('\\n', '\n')
        : tree;
      const next = turns.shift() ?? (() => []);
      return Promise.resolve({ text: '', calls: next(tree) });
    },
  };
  const result = await exploreApp(
    deps,
    {},
    {
      driver: scripted,
      skipPlatformConfig: true,
      sessionId: 'cu-calculator',
      focus: 'work out 7 times 6',
    },
  );
  assert.ok(systems[0]?.includes('a real desktop application'), 'not the prompt for a desktop');
  const acts = result.drive.toolCalls.filter((call) => 'reticle_act_and_wait' === call.name);
  assert.equal(acts.length, STEPS.length);
  for (const act of acts) {
    assert.ok(
      JSON.stringify(act.result).includes('"verified":"yes"'),
      JSON.stringify(act.result).slice(0, 300),
    );
  }
  assert.ok(display((await callTool(deps, 'reticle_snapshot', {})).tree).includes('42'));
  console.error(
    `computer calculator (Harness, scripted model): ${String(result.drive.toolCalls.length)} tool calls, ${String(acts.length)} presses proved`,
  );
} finally {
  await close();
  await bridge.close();
  rmSync('/tmp/reticle-test/.reticle/flows/cu-calculator', { recursive: true, force: true });
  // The goal that the Harness was given is kept as an intent, in a folder that the unit tests of
  // the server read too. Left there, its words came into the answer of another test.
  rmSync('/tmp/reticle-test/.reticle/intent', { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
