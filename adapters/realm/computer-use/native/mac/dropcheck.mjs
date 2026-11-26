// Checks a drag and drop from one application to another, as a person moves a file onto a window:
// the realm drags a file from a Finder window onto the fixture's Ink canvas, and the fixture must
// say the name of the file it got. The point of the drop is in a picture of the whole screen,
// because the canvas is in another application than the file.
//
//   node native/mac/dropcheck.mjs
//
// IT TAKES THE POINTER for a few seconds, and puts it back. Needs the Accessibility and Screen
// Recording permissions. Build the package first. It opens one Finder window on a folder of its
// own, and closes it.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const helper = `${build}/reticle-ax`;
const dir = execFileSync('realpath', [mkdtempSync(`${tmpdir()}/reticle-drop-`)], {
  encoding: 'utf8',
}).trim();
const FILE = 'drop-me.txt';
writeFileSync(`${dir}/${FILE}`, 'Reticle');

const fixture = spawn(`${build}/fixture`, [tmpdir()], { stdio: 'ignore' });
const onFixture = new PeerCommands({
  driver: new MacDriver({ helper, app: 'fixture', pid: fixture.pid }),
  emit: () => undefined,
});
const finderPid = Number(execFileSync('pgrep', ['-x', 'Finder'], { encoding: 'utf8' }).trim());
const onFinder = new PeerCommands({
  driver: new MacDriver({ helper, app: 'Finder', pid: finderPid }),
  emit: () => undefined,
});
const folder = dir.split('/').at(-1);
/**
 * The ref of the first element that fits `pattern`, inside the Finder window of the check's folder
 * only. Finder can have windows of the person, with the same elements in them.
 */
async function inOwnWindow(pattern) {
  const lines = String((await onFinder.answer(ReticleCommand.SNAPSHOT, {})).tree).split('\n');
  const start = lines.findIndex((line) => line.includes(`window "${folder}"`));
  if (start < 0) {
    return undefined;
  }
  const depth = lines[start].search(/\S/);
  const end = lines.findIndex((line, index) => index > start && line.search(/\S/) <= depth);
  return lines
    .slice(start, end < 0 ? undefined : end)
    .filter((line) => pattern.test(line))
    .map((line) => /\(ref=(e\d+)\)/.exec(line)?.[1])
    .find((ref) => ref !== undefined);
}

try {
  await sleep(1500);
  execFileSync('open', [dir]);
  await sleep(2000);
  // The file in the Finder window of the check's folder, by its name.
  // In column view the folder is the last column, and Finder can open the window scrolled to the
  // left, with that column out of view. A person turns the wheel to the right until they see it.
  let file;
  const fileLine = new RegExp(FILE.replace('.', '\\.'));
  for (let i = 0; i < 12 && file === undefined; i += 1) {
    file = await inOwnWindow(fileLine);
    const columns = await inOwnWindow(/group "column view"/);
    if (file === undefined && columns !== undefined) {
      await onFinder.answer(ReticleCommand.ACT, {
        ref: columns,
        action: ActionType.SCROLL,
        args: { foreground: true, dx: 1600, settleMs: 300 },
      });
    } else if (file === undefined) {
      await sleep(500);
    }
  }
  if (file === undefined) {
    const lines = String((await onFinder.answer(ReticleCommand.SNAPSHOT, {})).tree).split('\n');
    const windows = lines.filter((line) => /^ {2}- window/.test(line)).map((line) => line.trim());
    assert.fail(
      `Finder shows no ${FILE} in a window "${folder}". Its windows: ${windows.join(', ')}`,
    );
  }
  const ink = (await onFixture.answer(ReticleCommand.QUERY, { name: 'Ink' })).elements[0];
  const inkBox = (await onFixture.answer(ReticleCommand.INSPECT, { ref: ink.ref })).box;
  // Finder in front first: under Stage Manager its window slides in when it comes to the front,
  // and a picture taken before that is refused as old.
  const finderApp = (await onFinder.answer(ReticleCommand.QUERY, { role: 'application' }))
    .elements[0];
  await onFinder.answer(ReticleCommand.ACT, {
    ref: finderApp.ref,
    action: ActionType.FOCUS,
    args: { foreground: true, settleMs: 800 },
  });
  // The picture is the main display, from its top left corner: its pixels for each point are its
  // width over the width of the display. ponytail: one display; a second one is not placed.
  const display = Number(
    execFileSync(
      'osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSScreen.mainScreen.frame.size.width'],
      { encoding: 'utf8' },
    ).trim(),
  );
  /** A picture of the whole screen by the realm of the source, and the drag to the canvas in it. */
  const dragOnto = async () => {
    const shot = await onFinder.answer(ReticleCommand.CAPTURE, { screen: true });
    assert.equal(shot.ok, true, `no picture: ${String(shot.reason)}`);
    const scale = readFileSync(shot.path).readUInt32BE(16) / display;
    rmSync(shot.path, { force: true });
    return onFinder.answer(ReticleCommand.ACT, {
      ref: file,
      action: ActionType.DRAG,
      args: {
        foreground: true,
        toPoint: {
          x: Math.round((inkBox.x + inkBox.width / 2) * scale),
          y: Math.round((inkBox.y + inkBox.height / 2) * scale),
        },
        holdMs: 300,
        settleMs: 800,
      },
    });
  };
  // As the refusal says: when the window moved after the picture, take a new one and drag again.
  await dragOnto().catch((error) => {
    if (!/after the picture was taken/.test(String(error))) {
      throw error;
    }
    return dragOnto();
  });
  const status = (await onFixture.answer(ReticleCommand.QUERY, { role: 'text' })).elements[0]?.name;
  assert.equal(status, `Dropped: ${FILE}`);
  process.stdout.write('computer-use dropcheck: a file went from Finder to another application\n');
} finally {
  fixture.kill();
  // Only the Finder window of the check's folder, closed as a person closes it: never the first
  // close button of Finder, which can be in a window of the person.
  const close = await inOwnWindow(/button "Close window"/);
  if (close !== undefined) {
    await onFinder.answer(ReticleCommand.ACT, { ref: close, action: ActionType.CLICK });
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
