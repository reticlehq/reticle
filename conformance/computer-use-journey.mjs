// A whole journey on a real Electron application, through a real bridge and the tools an agent
// has: fill a field, add a note, choose from a list, check a box. The journey is recorded and
// saved. The application is then closed and opened again, and the saved flow replays with no
// model. The check holds when each step is proved and the replay leaves the same state.
//
//   node conformance/computer-use-journey.mjs
//
// macOS, with the Accessibility permission. Build the repository first. Not a gate: it opens a
// window on the screen.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { MacDriver, connectPeer } from '../adapters/realm/computer-use/dist/index.js';
import { Bridge } from '../server/dist/portal/bridge/bridge.js';
import { callTool, makeDeps, waitUntil } from '../server/dist/portal/bridge/bridge.test-harness.js';

if ('darwin' !== process.platform) {
  console.error('computer-use-journey: macOS only. Nothing was run.');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const native = join(root, 'adapters/realm/computer-use/native/mac');
const helper = join(native, 'build/reticle-ax');
execFileSync('swiftc', ['-O', join(native, 'reticle-ax.swift'), '-o', helper], { stdio: 'ignore' });
const electron = createRequire(join(root, 'apps/electron-smoke/package.json'))('electron');

const TOKEN = 'journey';
const PROJECT = 'computer-use-journey';
const bridge = new Bridge({ port: 0, token: TOKEN });
const port = await bridge.ready;
const deps = makeDeps(bridge);

/** Opens the application, sets its switch and joins it to the bridge. */
async function open() {
  const data = mkdtempSync(join(tmpdir(), 'cu-journey-'));
  const app = spawn(
    electron,
    [join(native, 'electron-fixture/main.mjs'), `--user-data-dir=${data}`],
    {
      stdio: 'ignore',
    },
  );
  await sleep(4000);
  execFileSync(helper, ['web-tree', String(app.pid), 'on']);
  const peer = connectPeer({
    url: `ws://localhost:${String(port)}/reticle`,
    token: TOKEN,
    sessionId: 'cu-journey',
    projectId: PROJECT,
    driver: new MacDriver({ helper, app: 'Electron', pid: app.pid }),
    now: () => Date.now(),
  });
  await peer.ready;
  await waitUntil(() => 1 === bridge.sessions.count());
  return async () => {
    peer.close();
    app.kill();
    await waitUntil(() => 0 === bridge.sessions.count());
    rmSync(data, { recursive: true, force: true });
  };
}

const visible = (query) => ({ kind: 'element', query, state: 'visible' });
const STEPS = [
  ['textbox "New note"', 'fill', { value: 'Buy milk' }, visible({ text: 'Buy milk' })],
  ['button "Add"', 'click', undefined, visible({ text: '1 notes' })],
  ['combobox "Priority"', 'select', { value: 'High' }, visible({ text: 'High' })],
  [
    'checkbox "Pinned"',
    'check',
    undefined,
    { kind: 'element', query: { role: 'checkbox', name: 'Pinned' }, state: 'checked' },
  ],
];
const END = ['value="Buy milk"', 'value="High"', 'checkbox "Pinned" (', 'text "1 notes"'];

let close = await open();
try {
  const page = await callTool(deps, 'reticle_snapshot', {});
  await callTool(deps, 'reticle_record', { action: 'start' });
  for (const [element, action, args, until] of STEPS) {
    const ref = page.tree.split('\n').find((line) => line.includes(`- ${element}`));
    const proved = await callTool(deps, 'reticle_act_and_wait', {
      ref: /ref=(e\d+)/.exec(ref ?? '')?.[1],
      action,
      ...(args === undefined ? {} : { args }),
      timeout_ms: 2000,
      until,
    });
    assert.equal(proved.verified, 'yes', `${action} on ${element}: ${String(proved.because)}`);
  }
  const recorded = await callTool(deps, 'reticle_record', { action: 'stop' });
  await callTool(deps, 'reticle_flow_save', { flowName: recorded.recordingName });

  // A new application: nothing of the first run is left in it.
  await close();
  close = await open();
  const started = Date.now();
  const replayed = await callTool(deps, 'reticle_flow_replay', {
    flowName: recorded.recordingName,
  });
  const took = Date.now() - started;
  assert.equal(replayed.status, 'ok', JSON.stringify(replayed.steps));
  const after = await callTool(deps, 'reticle_snapshot', {});
  for (const mark of END) {
    assert.ok(after.tree.includes(mark), `after the replay the application does not show: ${mark}`);
  }
  console.error(
    `computer-use journey: ${String(STEPS.length)} steps proved, and the saved flow replayed in ${String(took)} ms with no model`,
  );
} finally {
  await close();
  await bridge.close();
  rmSync(join('/tmp/reticle-test/.reticle/flows', PROJECT), { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
