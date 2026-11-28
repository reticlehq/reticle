// Two whole journeys on real applications, through a real bridge and the tools an agent has.
// Each journey is recorded and saved. The application is then closed, a new one is opened, and
// the saved flow replays with no model. A journey holds when each step is proved and the replay
// leaves the same state.
//   - An Electron application: fill a field, add a note, choose from a list, check a box.
//   - A native application: fill a field and export it. The proof is the file on disk, not the
//     words the application shows, and the replay must write the file in a new folder.
//   - The Harness drives the native application, with a model that is a script.
//
//   node conformance/computer-journey.mjs
//
// macOS, with the Accessibility permission. Build the repository first. Not a gate: it opens a
// window on the screen.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { nodeWorkspace } from '../adapters/realm/terminal/dist/index.js';
import { MacDriver, connectPeer } from '../adapters/realm/computer/dist/index.js';
import { FINISH_TOOL } from '../server/dist/features/harness/harness.js';
import { Bridge } from '../server/dist/portal/bridge/bridge.js';
import { exploreApp } from '../server/dist/surface/tools/harness-explore.js';
import { callTool, makeDeps, waitUntil } from '../server/dist/portal/bridge/bridge.test-harness.js';

if ('darwin' !== process.platform) {
  console.error('computer-journey: macOS only. Nothing was run.');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const native = join(root, 'adapters/realm/computer/native/mac');
const helper = join(native, 'build/reticle-ax');
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', join(native, `${name}.swift`), '-o', join(native, 'build', name)], {
    stdio: 'ignore',
  });
}
const electron = createRequire(join(root, 'apps/electron-smoke/package.json'))('electron');

const TOKEN = 'journey';
const PROJECT = 'computer-journey';
const bridge = new Bridge({ port: 0, token: TOKEN });
const port = await bridge.ready;
const deps = makeDeps(bridge);

/** Joins a running application to the bridge. The answer closes it and its folder. */
async function join_(app, name, folder, workspace) {
  const peer = connectPeer({
    url: `ws://localhost:${String(port)}/reticle`,
    token: TOKEN,
    sessionId: 'cu-journey',
    projectId: PROJECT,
    driver: new MacDriver({ helper, app: name, pid: app.pid }),
    ...(workspace === undefined ? {} : { workspace, filesEveryMs: 200 }),
    now: () => Date.now(),
  });
  await peer.ready;
  await waitUntil(() => 1 === bridge.sessions.count());
  return {
    folder,
    close: async () => {
      peer.close();
      app.kill();
      await waitUntil(() => 0 === bridge.sessions.count());
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

async function openElectron() {
  const data = mkdtempSync(join(tmpdir(), 'cu-journey-'));
  const app = spawn(
    electron,
    [join(native, 'electron-fixture/main.mjs'), `--user-data-dir=${data}`],
    { stdio: 'ignore' },
  );
  await sleep(4000);
  execFileSync(helper, ['web-tree', String(app.pid), 'on']);
  return join_(app, 'Electron', data);
}

async function openNative() {
  const folder = mkdtempSync(join(tmpdir(), 'cu-journey-'));
  const app = spawn(join(native, 'build/fixture'), [folder], { stdio: 'ignore' });
  await sleep(1500);
  return join_(app, 'fixture', folder, nodeWorkspace([folder], { exclude: [] }));
}

const visible = (query) => ({ kind: 'element', query, state: 'visible' });
const JOURNEYS = [
  {
    name: 'Electron',
    open: openElectron,
    steps: [
      ['textbox "New note"', 'fill', { value: 'Buy milk' }, visible({ text: 'Buy milk' })],
      ['button "Add"', 'click', undefined, visible({ text: '1 notes' })],
      ['combobox "Priority"', 'select', { value: 'High' }, visible({ text: 'High' })],
      [
        'checkbox "Pinned"',
        'check',
        undefined,
        { kind: 'element', query: { role: 'checkbox', name: 'Pinned' }, state: 'checked' },
      ],
    ],
    end: (tree) => {
      for (const mark of ['value="Buy milk"', 'value="High"', 'text "1 notes"']) {
        assert.ok(tree.includes(mark), `after the replay the application does not show: ${mark}`);
      }
    },
  },
  {
    name: 'native',
    open: openNative,
    steps: [
      ['textbox "Title"', 'fill', { value: 'Plan' }, visible({ text: 'Plan' })],
      [
        'button "Export"',
        'click',
        undefined,
        { kind: 'signal', name: 'file.written', dataMatches: { file: 'note.txt' } },
      ],
    ],
    // The file, in the folder of the NEW application: the replay wrote it.
    end: (_tree, folder) => {
      assert.equal(readFileSync(join(folder, 'note.txt'), 'utf8'), 'Plan');
    },
  },
];

async function run(journey) {
  let opened = await journey.open();
  try {
    const page = await callTool(deps, 'reticle_snapshot', {});
    await callTool(deps, 'reticle_record', { action: 'start' });
    for (const [element, action, args, until] of journey.steps) {
      const line = page.tree.split('\n').find((one) => one.includes(`- ${element}`));
      const proved = await callTool(deps, 'reticle_act_and_wait', {
        ref: /ref=(e\d+)/.exec(line ?? '')?.[1],
        action,
        ...(args === undefined ? {} : { args }),
        timeout_ms: 3000,
        until,
      });
      assert.equal(proved.verified, 'yes', `${action} on ${element}: ${String(proved.because)}`);
    }
    const recorded = await callTool(deps, 'reticle_record', { action: 'stop' });
    await callTool(deps, 'reticle_flow_save', { flowName: recorded.recordingName });

    // A new application: nothing of the first run is left in it.
    await opened.close();
    opened = await journey.open();
    const started = Date.now();
    const replayed = await callTool(deps, 'reticle_flow_replay', {
      flowName: recorded.recordingName,
    });
    const took = Date.now() - started;
    assert.equal(replayed.status, 'ok', JSON.stringify(replayed.steps));
    journey.end((await callTool(deps, 'reticle_snapshot', {})).tree, opened.folder);
    console.error(
      `computer journey (${journey.name}): ${String(journey.steps.length)} steps proved, and the saved flow replayed in ${String(took)} ms with no model`,
    );
  } finally {
    await opened.close();
  }
}

/**
 * The Harness drives the native application. The model is a script here, so the run costs
 * nothing and is the same each time: what is checked is the Harness around the model, the prompt
 * it gives for a desktop application, and the tools as the Harness calls them.
 */
async function runHarness() {
  const opened = await openNative();
  try {
    const refOf = (tree, element) =>
      /ref=(e\d+)/.exec(tree.split('\n').find((one) => one.includes(`- ${element}`)) ?? '')?.[1];
    const turns = [
      () => [{ id: '1', name: 'reticle_snapshot', args: {} }],
      () => [{ id: '2', name: 'reticle_record', args: { action: 'start' } }],
      (tree) => [
        {
          id: '3',
          name: 'reticle_act_and_wait',
          args: {
            ref: refOf(tree, 'textbox "Title"'),
            action: 'fill',
            args: { value: 'Plan' },
            timeout_ms: 3000,
            until: visible({ text: 'Plan' }),
          },
        },
      ],
      (tree) => [
        {
          id: '4',
          name: 'reticle_act_and_wait',
          args: {
            ref: refOf(tree, 'button "Export"'),
            action: 'click',
            timeout_ms: 3000,
            until: { kind: 'signal', name: 'file.written', dataMatches: { file: 'note.txt' } },
          },
        },
      ],
      () => [{ id: '5', name: 'reticle_flow_save', args: { flowName: 'default' } }],
      () => [{ id: '6', name: FINISH_TOOL.name, args: { summary: 'exported', goalMet: true } }],
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
        sessionId: 'cu-journey',
        focus: 'export a note',
      },
    );
    assert.ok(systems[0]?.includes('a real desktop application'), 'not the prompt for a desktop');
    const acts = result.drive.toolCalls.filter((call) => 'reticle_act_and_wait' === call.name);
    assert.equal(acts.length, 2);
    for (const act of acts) {
      assert.ok(
        JSON.stringify(act.result).includes('"verified":"yes"'),
        JSON.stringify(act.result).slice(0, 300),
      );
    }
    const saved = result.drive.toolCalls.find((call) => 'reticle_flow_save' === call.name);
    assert.ok(
      false === saved?.isError && JSON.stringify(saved.result).includes('"stepCount":2'),
      `the Harness did not save the flow: ${JSON.stringify(saved?.result).slice(0, 300)}`,
    );
    assert.equal(readFileSync(join(opened.folder, 'note.txt'), 'utf8'), 'Plan');
    console.error(
      `computer journey (Harness, scripted model): ${String(result.drive.toolCalls.length)} tool calls, 2 steps proved, the file is on disk`,
    );
  } finally {
    await opened.close();
  }
}

try {
  for (const journey of JOURNEYS) {
    await run(journey);
  }
  await runHarness();
} finally {
  await bridge.close();
  rmSync(join('/tmp/reticle-test/.reticle/flows', PROJECT), { recursive: true, force: true });
  // The native application keeps one setting. Remove it, so that the next run starts with none.
  spawn('defaults', ['delete', 'fixture'], { stdio: 'ignore' });
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
