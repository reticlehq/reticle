// Checks a column view, as Finder shows a folder. The fixture shows a column of 500 files: the
// realm reads the files on the screen and says how many it left out, as it does for a table, and
// a click on a file picks it. A list was read whole before, all 500 items, each one a call.
//
// Finder gives a column as a scroll area with no children and its list only as its contents, so
// every file of the column was missing, and a click on one was "stale". The check opens a Finder
// window of its own on a folder of five files, reads the column, and clicks a file in it.
//
//   node native/mac/columncheck.mjs
//
// Needs the Accessibility permission. Build the package first. IT TAKES THE SCREEN for a moment:
// Finder comes to the front, and stays there when the check ends.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

  // Finder: a window of its own, in column view, on a folder of five files that the check makes.
  // The setup uses AppleScript; every action of the check goes through the realm.
  // A short way (four columns) in a wide window: every column of the way is a column of the view,
  // and a column right of the window is out of view, for a person and for the realm.
  const folder = mkdtempSync('/private/tmp/reticle-columns-');
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(folder, `column-file-${String(i)}.txt`), 'x');
  }
  try {
    execFileSync('osascript', [
      '-e',
      `tell application "Finder" to set current view of (make new Finder window to (POSIX file "${folder}" as alias)) to column view`,
      '-e',
      'tell application "Finder" to set bounds of Finder window 1 to {0, 40, 1440, 640}',
    ]);
    await sleep(1500);
    const finderPid = Number(execFileSync('pgrep', ['-x', 'Finder'], { encoding: 'utf8' }).trim());
    const finder = peer('Finder', finderPid);
    // A window of Finder on another desktop, or in another set of Stage Manager, gives no
    // elements. A person brings Finder to the front first, and so does the check.
    await finder.answer(ReticleCommand.ACT, {
      ref: refIn(await tree(finder), '- application'),
      action: ActionType.FOCUS,
      args: { foreground: true, settleMs: 800 },
    });
    // Finder fills the column of a new window a moment after it shows the window.
    let inFinder = await tree(finder);
    for (let i = 0; i < 10 && !inFinder.includes('"column-file-2.txt"'); i += 1) {
      await sleep(500);
      inFinder = await tree(finder);
    }
    assert.ok(inFinder.includes('group "column view"'), 'Finder shows no column view');
    assert.ok(inFinder.includes('"column-file-2.txt"'), 'the column of Finder shows no file');
    // A click on a file of the column chooses it. The way to the file goes through the contents
    // of the column, and every click there was "stale".
    await finder.answer(ReticleCommand.ACT, {
      ref: refIn(inFinder, '"column-file-2.txt"'),
      action: ActionType.CLICK,
      args: { settleMs: 800 },
    });
    const chosen = execFileSync(
      'osascript',
      ['-e', 'tell application "Finder" to get name of item 1 of (get selection)'],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(chosen, 'column-file-2.txt', 'a click on a file of Finder did not choose it');
  } finally {
    // By its place in the list: Finder cannot close "every window whose name is" one name.
    execFileSync('osascript', [
      '-e',
      'tell application "Finder"',
      '-e',
      'set n to name of every Finder window',
      '-e',
      'repeat with i from (count n) to 1 by -1',
      '-e',
      `if item i of n is "${basename(folder)}" then close Finder window i`,
      '-e',
      'end repeat',
      '-e',
      'end tell',
    ]);
    rmSync(folder, { recursive: true, force: true });
  }
  process.stdout.write('computer-use columncheck: 7 of 7 cases held\n');
} finally {
  fixture.kill();
}
