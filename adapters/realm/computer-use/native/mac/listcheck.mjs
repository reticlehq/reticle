// Checks a long list of a Chromium page (the channels of Discord, the messages of Slack), in the
// Electron fixture. A person sees the items in the window, and so does the realm. The line of the
// list says how many items are out of view: it said nothing, and an agent took the ten channels
// it saw for the whole list. A scroll of the list brings the last channel into the tree.
//
//   node native/mac/listcheck.mjs
//
// Needs the Accessibility permission. Build the package first.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
execFileSync('swiftc', ['-O', `${here}reticle-ax.swift`, '-o', `${build}/reticle-ax`], {
  stdio: ['ignore', 'ignore', 'ignore'],
});

let electron;
try {
  const fixture = fileURLToPath(new URL('../../../../../apps/electron-smoke/', import.meta.url));
  electron = createRequire(`${fixture}package.json`)('electron');
} catch {
  process.stdout.write('computer-use listcheck: skipped, Electron is not installed\n');
  process.exit(0);
}

const data = mkdtempSync(join(tmpdir(), 'reticle-cu-list-'));
const app = spawn(electron, [`${here}electron-fixture/main.mjs`, `--user-data-dir=${data}`], {
  stdio: 'ignore',
  env: { ...process.env, RETICLE_FIXTURE_PAGE: 'list' },
});
const helper = `${build}/reticle-ax`;
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: 'Electron', pid: app.pid }),
  emit: () => undefined,
});
const tree = async () => (await commands.answer(ReticleCommand.SNAPSHOT, {})).tree;

try {
  await sleep(4000);
  execFileSync(helper, ['web-tree', String(app.pid), 'on']);
  await sleep(1000);
  const first = await tree();
  const listLine = first.split('\n').find((l) => l.includes('list "Channels"')) ?? '';
  assert.ok(first.includes('"channel 0"'), 'the first item of the list is not read');
  assert.ok(/\[not shown: \d+\]/.test(listLine), `the list does not say it has more: ${listLine}`);
  const ref = listLine.split('ref=')[1]?.split(')')[0];
  const moved = await commands.answer(ReticleCommand.SCROLL, {
    ref,
    fraction: 1,
    foreground: true,
  });
  assert.equal(moved.by, 'wheel', 'the list was not scrolled with the wheel');
  await sleep(500);
  assert.ok((await tree()).includes('"channel 299"'), 'the last item is not read after a scroll');
  process.stdout.write('computer-use listcheck: 3 of 3 cases held\n');
} finally {
  app.kill();
  await sleep(500);
  rmSync(data, { recursive: true, force: true });
}
