// Edits a video in QuickTime Player, as a person does, and proves the edit in the exported file:
// the realm trims a 10-second clip to the part from 2 s to 6 s, exports it at 480p into a folder
// it chooses in the save panel, and the exported movie must be 4 seconds long.
//
//   node native/mac/videocheck.mjs
//
// IT TAKES THE POINTER to drag the two handles, and THE KEYBOARD for two keys in the save panel.
// Needs the Accessibility permission. Build the package first.
// Does not run if QuickTime Player is open already: its windows belong to the person.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const APP = 'QuickTime Player';
const here = fileURLToPath(new URL('.', import.meta.url));
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if (0 !== pidOf()) {
  process.stdout.write('computer videocheck: skipped, QuickTime Player is open already\n');
  process.exit(0);
}

// realpath: the save panel names /private/var, and the folder must be the same text.
const dir = execFileSync('realpath', [mkdtempSync(`${tmpdir()}/reticle-video-`)], {
  encoding: 'utf8',
}).trim();
const clip = `${dir}/clip.mov`;
const exported = `${dir}/trimmed.mov`;
// The clip is made, and the export measured, with AVFoundation: no tool to install.
execFileSync('swiftc', ['-O', `${here}video.swift`, '-o', `${dir}/video`], { stdio: 'ignore' });
execFileSync(`${dir}/video`, [clip]);
const seconds = (path) =>
  Number(execFileSync(`${dir}/video`, [path, '--seconds'], { encoding: 'utf8' }).trim());
assert.ok(Math.abs(seconds(clip) - 10) < 0.1);

execFileSync('open', ['-a', APP, clip]);
await sleep(3500);
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${here}build/reticle-ax`, app: APP, pid: pidOf() }),
  emit: () => undefined,
});
const find = async (query) => (await commands.answer(ReticleCommand.QUERY, query)).elements;
const act = async (ref, action, args = {}) =>
  commands.answer(ReticleCommand.ACT, { ref, action, args: { settleMs: 800, ...args } });
/** A menu item, as a person reaches it: the menu of the bar, then its item, then a sub-item. */
async function menu(bar, ...items) {
  // The last match: a window can have an item with the name of a menu, before the bar.
  await act((await find({ role: 'menuitem', name: bar })).at(-1).ref, ActionType.CLICK);
  for (const item of items) {
    const [entry] = await find({ role: 'menuitem', name: item });
    assert.ok(entry, `no "${item}" in the ${bar} menu`);
    await act(entry.ref, ActionType.CLICK);
  }
}

let passed = 0;
try {
  await menu('Edit', 'Trim…');
  const [start] = await find({ name: 'timeline selection start time' });
  const [end] = await find({ name: 'timeline selection end time' });
  assert.ok(start && end, 'the trim bar has no handles');
  // A person drags the yellow handles. Setting their values is not enough: QuickTime takes the
  // part to keep when a handle is let go, and a trim after a set value kept all 10 seconds.
  const window = (await find({ role: 'window' }))[0];
  const windowBox = (await commands.answer(ReticleCommand.INSPECT, { ref: window.ref })).box;
  /** A new picture for each drag: the last drag moved a handle, so an old picture is refused. */
  const picture = async () => {
    const shot = await commands.answer(ReticleCommand.CAPTURE, {});
    assert.equal(shot.ok, true, `no picture: ${String(shot.reason)}`);
    return readFileSync(shot.path).readUInt32BE(16) / windowBox.width;
  };
  let scale = await picture();
  const boxOf = async (ref) => (await commands.answer(ReticleCommand.INSPECT, { ref })).box;
  const [startBox, endBox] = [await boxOf(start.ref), await boxOf(end.ref)];
  const middle = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  // The handles stand at 0 s and at 10 s: the points between them are the seconds.
  const from = middle(startBox);
  const perSecond = (middle(endBox).x - from.x) / 10;
  const toPicture = (second) => ({
    x: Math.round((from.x + perSecond * second - windowBox.x) * scale),
    y: Math.round((from.y - windowBox.y) * scale),
  });
  await act(start.ref, ActionType.DRAG, { foreground: true, toPoint: toPicture(2) });
  scale = await picture();
  await act(end.ref, ActionType.DRAG, { foreground: true, toPoint: toPicture(6) });
  const values = (await find({ role: 'slider' })).map((s) => Number(s.value));
  const [kept0, kept1] = values;
  assert.ok(Math.abs(kept0 - 2) < 0.3 && Math.abs(kept1 - 6) < 0.3, `the handles are at ${values}`);
  await act((await find({ role: 'button', name: 'Trim' }))[0].ref, ActionType.CLICK);
  // The proof in the application: the player shows the new length.
  const shown = (await find({ role: 'text' })).map((t) => t.name);
  assert.ok(
    shown.includes('00:04') || shown.includes('00:03'),
    `the player shows ${shown.join(', ')}`,
  );
  passed += 1;

  await menu('File', 'Export As', '480p…');
  await sleep(1000);
  const [name] = await find({ by: 'testid', value: 'saveAsNameTextField' });
  assert.ok(name, 'the export panel was not read');
  // The panel opens in the folder it used last, which can be in iCloud. Go to the check's own
  // folder, as a person does: Command-Shift-G, the path, Return.
  await act(name.ref, ActionType.PRESS, { text: 'Meta+Shift+g', foreground: true });
  const goTo = (await find({ role: 'textbox' })).find((box) => String(box.value).startsWith('/'));
  assert.ok(goTo, 'the "Go to folder" sheet did not open');
  // The trailing slash names the folder itself, so no other row of the list of matches is taken.
  await act(goTo.ref, ActionType.FILL, { value: `${dir}/` });
  await sleep(500);
  await act(goTo.ref, ActionType.PRESS, { text: 'Return', foreground: true });
  const [where] = await find({ role: 'combobox', name: 'Where:' });
  assert.ok(String(where?.value).includes(dir.split('/').at(-1)), `the folder is ${where?.value}`);
  passed += 1;

  await act(name.ref, ActionType.FILL, { value: 'trimmed' });
  await act((await find({ role: 'button', name: 'Save' })).at(-1).ref, ActionType.CLICK);
  // The export runs after the panel closes. Done when the file is there and stops growing.
  let size = -1;
  for (let waited = 0; waited < 60; waited += 1) {
    await sleep(1000);
    const now = existsSync(exported) ? statSync(exported).size : -1;
    if (now > 0 && now === size) break;
    size = now;
  }
  assert.ok(size > 0, 'nothing was exported');
  passed += 1;

  const length = seconds(exported);
  assert.ok(
    Math.abs(length - (kept1 - kept0)) < 0.2,
    `the export is ${length} s, not ${kept1 - kept0}`,
  );
  passed += 1;
  process.stdout.write(
    `computer videocheck: ${passed} of 4 edits proved, the export is ${length.toFixed(2)} s\n`,
  );
} finally {
  if (0 !== pidOf()) {
    process.kill(pidOf(), 'SIGTERM');
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
