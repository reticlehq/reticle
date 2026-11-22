// Checks a column view, as Finder shows a folder. The fixture shows a column of 500 files: the
// realm reads the files on the screen and says how many it left out, as it does for a table, and
// a click on a file picks it. A list was read whole before, all 500 items, each one a call.
//
// Finder gives a column as a scroll area with no children and its list only as its contents, so
// every file of the column was missing. When a Finder window in column view is open, the check
// reads it too, and says that it found files there. It prints no name of a file.
//
//   node native/mac/columncheck.mjs
//
// Needs the Accessibility permission. Build the package first. No pointer and no keyboard.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const fixture = spawn(`${build}/fixture`, [tmpdir()], {
  stdio: 'ignore',
  env: { ...process.env, RETICLE_FIXTURE_COLUMNS: '1' },
});
const peer = (app, pid) =>
  new PeerCommands({
    driver: new MacDriver({ helper: `${build}/reticle-ax`, app, pid }),
    emit: () => undefined,
  });
const commands = peer('fixture', fixture.pid);
const tree = async (on = commands) => (await on.answer(ReticleCommand.SNAPSHOT, {})).tree;
const refIn = (text, words) =>
  text
    .split('\n')
    .find((line) => line.includes(words))
    ?.split('ref=')[1]
    ?.split(')')[0];

let finder = 'no Finder window in column view';
try {
  await sleep(1500);
  const shown = await tree();
  assert.ok(shown.includes('"File 0"'), 'the first file of the column is not read');
  assert.ok(!shown.includes('"File 400"'), 'a file far below the screen is read');
  assert.ok(/\[not shown: \d+\]/.test(shown), 'the column does not say how many files it left out');

  await commands.answer(ReticleCommand.ACT, {
    ref: refIn(shown, '"File 3"'),
    action: ActionType.CLICK,
    args: { settleMs: 300 },
  });
  assert.ok((await tree()).includes('Picked: File 3'), 'a click on a file did not pick it');

  const finderPid = Number(execFileSync('pgrep', ['-x', 'Finder'], { encoding: 'utf8' }).trim());
  const inFinder = await tree(peer('Finder', finderPid));
  const lines = inFinder.split('\n');
  const view = lines.findIndex((l) => l.includes('group "column view"'));
  if (view >= 0) {
    const list = lines.findIndex((l, i) => i > view && l.trimStart().startsWith('- list'));
    const indent = (l = '') => l.length - l.trimStart().length;
    assert.ok(list > view, 'the column view of Finder has no list');
    assert.ok(indent(lines[list + 1]) > indent(lines[list]), 'a column of Finder shows no file');
    finder = 'the column view of Finder shows its files';
  }
  process.stdout.write(`computer-use columncheck: 4 of 4 cases held (${finder})\n`);
} finally {
  fixture.kill();
}
