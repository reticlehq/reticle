// A form in a real browser, through a real bridge and the tools an agent has. Chrome shows a page
// of this repository. The realm fills a field and presses a button, and each step is proved by
// what the page then shows. The task is saved as a flow, Chrome is closed and opened again, and
// the flow replays with no model. It holds when the note is on the page after the replay too.
//
//   node conformance/computer-use-browser.mjs            (Chrome)
//   node conformance/computer-use-browser.mjs --safari   (Safari)
//
// macOS, with the Accessibility permission and Google Chrome. Build the repository first. Not a
// gate: it opens Chrome on the screen. It does not run when Chrome is open already: those
// windows belong to the person. Chrome runs with a profile of this run, so it reads no account.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { MacDriver, connectPeer, isElectron } from '../adapters/realm/computer-use/dist/index.js';
import { Bridge } from '../server/dist/portal/bridge/bridge.js';
import { callTool, makeDeps, waitUntil } from '../server/dist/portal/bridge/bridge.test-harness.js';

// Chrome, or Safari with --safari. Safari has no profile of the run: it opens the page in the
// profile of the person, and the check reads and writes that one page only.
const SAFARI = process.argv.includes('--safari');
const APP = SAFARI ? 'Safari' : 'Google Chrome';
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if ('darwin' !== process.platform || !existsSync(`/Applications/${APP}.app`) || 0 !== pidOf()) {
  console.error(
    `computer-use-browser: not macOS, no ${APP}, or ${APP} is open already. Nothing was run.`,
  );
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const native = `${root}adapters/realm/computer-use/native/mac/`;
const helper = `${native}build/reticle-ax`;
const TOKEN = 'browser';
const bridge = new Bridge({ port: 0, token: TOKEN });
const port = await bridge.ready;
const deps = makeDeps(bridge);
const profile = mkdtempSync(join(tmpdir(), 'reticle-cu-chrome-'));
const snapshot = async () => (await callTool(deps, 'reticle_snapshot', {})).tree;

/** Starts Chrome on the page and joins it. The answer closes both. */
async function open() {
  execFileSync(
    'open',
    SAFARI
      ? ['-a', APP, `${native}form.html`]
      : [
          '-na',
          APP,
          '--args',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          `file://${native}form.html`,
        ],
  );
  let pid = 0;
  for (let tries = 0; tries < 40 && 0 === pid; tries += 1) {
    await sleep(250);
    pid = pidOf();
  }
  assert.ok(0 !== pid, `${APP} did not start`);
  // The switch is set when the join would set it, by the same test, and never by hand: a check
  // that set it by hand passed while the join never set it for Chrome.
  const program = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(isElectron(program, existsSync), !SAFARI, `the join takes ${APP} for another kind`);
  if (isElectron(program, existsSync)) {
    execFileSync(helper, ['web-tree', String(pid), 'on']);
  }
  const peer = connectPeer({
    url: `ws://localhost:${String(port)}/reticle`,
    token: TOKEN,
    sessionId: 'cu-browser',
    projectId: 'cu-browser',
    driver: new MacDriver({ helper, app: APP, pid }),
    now: () => Date.now(),
  });
  await peer.ready;
  await waitUntil(() => 1 === bridge.sessions.count());
  for (let tries = 0; tries < 60 && !(await snapshot()).includes('button "Add"'); tries += 1) {
    await sleep(250);
  }
  return async () => {
    peer.close();
    process.kill(pid);
    await waitUntil(() => 0 === bridge.sessions.count());
    await sleep(3000);
  };
}

// Each step: the line of the element, the action, its arguments, and what the page must then show.
// The fill declares nothing: Reticle has no check for the value of a field. The press proves it,
// because the note that comes on the page has the words that were filled.
const STEPS = [
  ['textbox "New note"', 'fill', { value: 'Buy milk' }, undefined],
  ['button "Add"', 'click', undefined, { role: 'text', text: 'Buy milk' }],
];

let close = await open();
try {
  const page = await snapshot();
  await callTool(deps, 'reticle_record', { action: 'start' });
  for (const [element, action, args, shows] of STEPS) {
    const line = page.split('\n').find((one) => one.includes(`- ${element}`));
    const ref = /ref=(e\d+)/.exec(line ?? '')?.[1];
    assert.ok(ref, `no ${element} on the page:\n${page}`);
    if (shows === undefined) {
      await callTool(deps, 'reticle_act', { ref, action, args });
      continue;
    }
    const proved = await callTool(deps, 'reticle_act_and_wait', {
      ref,
      action,
      timeout_ms: 3000,
      until: { kind: 'element', query: shows, state: 'visible' },
    });
    assert.equal(proved.verified, 'yes', `${action} on ${element}: ${String(proved.because)}`);
  }
  assert.ok((await snapshot()).includes('text "Buy milk"'), 'the note is not on the page');
  const recorded = await callTool(deps, 'reticle_record', { action: 'stop' });
  await callTool(deps, 'reticle_flow_save', { flowName: recorded.recordingName });

  // A new Chrome: nothing of the first run is left on the page.
  await close();
  close = await open();
  assert.ok(
    !(await snapshot()).includes('text "Buy milk"'),
    'the page kept the note of the first run',
  );
  const started = Date.now();
  const replayed = await callTool(deps, 'reticle_flow_replay', {
    flowName: recorded.recordingName,
  });
  const took = Date.now() - started;
  assert.equal(replayed.status, 'ok', JSON.stringify(replayed.steps));
  assert.ok((await snapshot()).includes('text "Buy milk"'), 'the replay did not add the note');
  console.error(
    `computer-use browser: ${String(STEPS.length)} steps proved in ${APP}, and the saved flow replayed in ${String(took)} ms with no model`,
  );
} finally {
  await close();
  await bridge.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync('/tmp/reticle-test/.reticle/flows/cu-browser', { recursive: true, force: true });
}
