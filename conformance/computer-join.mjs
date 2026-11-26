// Joins a real Chrome through the command an agent runs, `reticle-computer --app`, and not
// through the realm class. The command must set the accessibility switch of Chrome by itself:
// without it Chrome answers "done" to a press, and the page gets no click. A fill and a press are
// then proved through a real bridge and the tools an agent has.
//
//   node conformance/computer-join.mjs
//
// macOS, with the Accessibility permission and Google Chrome. Build the repository first. Not a
// gate: it opens Chrome on the screen. It does not run when Chrome is open already. Chrome runs
// with a profile of this run, so it reads no account.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Bridge } from '../server/dist/portal/bridge/bridge.js';
import { callTool, makeDeps, waitUntil } from '../server/dist/portal/bridge/bridge.test-harness.js';

const APP = 'Google Chrome';
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if ('darwin' !== process.platform || !existsSync(`/Applications/${APP}.app`) || 0 !== pidOf()) {
  console.error('computer-join: not macOS, no Chrome, or Chrome is open already. Nothing was run.');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const native = `${root}adapters/realm/computer/native/mac/`;
// A port of its own, so that a daemon of the person on the usual port is not touched.
const PORT = 14457;
const TOKEN = 'join';
const bridge = new Bridge({ port: PORT, token: TOKEN });
await bridge.ready;
const deps = makeDeps(bridge);
const profile = mkdtempSync(join(tmpdir(), 'reticle-cu-chrome-'));
execFileSync('open', [
  '-na',
  APP,
  '--args',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  `file://${native}form.html`,
]);
let pid = 0;
for (let tries = 0; tries < 40 && 0 === pid; tries += 1) {
  await sleep(250);
  pid = pidOf();
}
assert.ok(0 !== pid, 'Chrome did not start');
let said = '';
const command = spawn(
  'node',
  [
    `${root}adapters/realm/computer/bin/attach.mjs`,
    '--app',
    APP,
    '--port',
    String(PORT),
    '--no-hud',
  ],
  { env: { ...process.env, RETICLE_TOKEN: TOKEN } },
);
command.stdout.on('data', (chunk) => {
  said += String(chunk);
});
command.stderr.on('data', (chunk) => {
  said += String(chunk);
});

try {
  await waitUntil(() => said.includes('"joined"'), 30_000);
  const page = (await callTool(deps, 'reticle_snapshot', {})).tree;
  const refOf = (element) =>
    /ref=(e\d+)/.exec(page.split('\n').find((line) => line.includes(`- ${element}`)) ?? '')?.[1];
  assert.ok(refOf('button "Add"'), `the page was not read through the command:\n${said}`);
  await callTool(deps, 'reticle_act', {
    ref: refOf('textbox "New note"'),
    action: 'fill',
    args: { value: 'Joined' },
  });
  const proved = await callTool(deps, 'reticle_act_and_wait', {
    ref: refOf('button "Add"'),
    action: 'click',
    timeout_ms: 3000,
    until: { kind: 'element', query: { role: 'text', text: 'Joined' }, state: 'visible' },
  });
  assert.equal(
    proved.verified,
    'yes',
    `the press did not reach the page: ${String(proved.because)}`,
  );
  console.error('computer join: Chrome was joined by the command, and a press was proved');
} finally {
  command.kill('SIGINT');
  await sleep(1500);
  process.kill(pid);
  await bridge.close();
  await sleep(1500);
  rmSync(profile, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
