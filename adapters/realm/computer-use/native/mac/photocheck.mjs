// Edits a photo in Preview, as a person does, and proves each edit from outside the application:
// the realm rotates the photo from the Tools menu, draws a stroke on it with the markup tool, and
// saves it. The saved file must be turned (400 x 600 from 600 x 400) and must have the stroke.
// The stroke changes no element, so the realm must see it in the pixels of the window.
//
//   node native/mac/photocheck.mjs
//
// IT TAKES THE POINTER for the stroke, and puts it back. Needs the Accessibility and Screen
// Recording permissions. Build the package first. Do not move the pointer while it runs.
// Does not run if Preview is open already: its windows belong to the person.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const APP = 'Preview';
const here = fileURLToPath(new URL('.', import.meta.url));
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if (0 !== pidOf()) {
  process.stdout.write('computer-use photocheck: skipped, Preview is open already\n');
  process.exit(0);
}

const dir = mkdtempSync(`${tmpdir()}/reticle-photo-`);
const photo = `${dir}/photo.png`;
execFileSync('swiftc', ['-O', `${here}photo.swift`, '-o', `${dir}/make`], { stdio: 'ignore' });
execFileSync(`${dir}/make`, [photo]);
const size = () =>
  execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', photo], { encoding: 'utf8' })
    .match(/\d+$/gm)
    ?.join('x');
/** How many pixels of the saved photo cannot be the photo's own: the photo is all blue tones. */
const strokePixels = () =>
  Number(execFileSync(`${dir}/make`, [photo, '--count-unlike'], { encoding: 'utf8' }).trim());
assert.equal(size(), '600x400');
const strokeBefore = strokePixels();

execFileSync('open', ['-a', APP, photo]);
await sleep(3000);
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${here}build/reticle-ax`, app: APP, pid: pidOf() }),
  emit: () => undefined,
});
const find = async (query) => (await commands.answer(ReticleCommand.QUERY, query)).elements[0];
const act = async (ref, action, args = {}) =>
  commands.answer(ReticleCommand.ACT, { ref, action, args: { settleMs: 600, ...args } });
/** A menu item, as a person reaches it: the menu of the bar, then its item. */
async function menu(bar, item) {
  // The last match: a toolbar can have an item with the name of a menu ("View"), before the bar.
  const bars = (await commands.answer(ReticleCommand.QUERY, { role: 'menuitem', name: bar }))
    .elements;
  await act(bars.at(-1).ref, ActionType.CLICK);
  const entry = await find({ role: 'menuitem', name: item });
  assert.ok(entry, `no "${item}" in the ${bar} menu`);
  return act(entry.ref, ActionType.CLICK);
}

let passed = 0;
try {
  await menu('Tools', 'Rotate Left');
  passed += 1;

  // Preview keeps the markup toolbar shown from the last time: open it only when it is not there.
  const sketch = () => find({ role: 'checkbox', name: 'Sketch' });
  if ((await sketch()) === undefined) {
    await menu('View', 'Show Markup Toolbar');
  }
  const draw = await sketch();
  assert.ok(draw, 'the markup toolbar shows no Sketch tool');
  await act(draw.ref, ActionType.CLICK);
  passed += 1;

  // The stroke goes across the middle of the photo, in points of a picture of the window.
  const window = await find({ role: 'window' });
  const shot = await commands.answer(ReticleCommand.CAPTURE, {});
  assert.equal(shot.ok, true, `no picture: ${String(shot.reason)}`);
  // The picture's own pixels: its width is in the header of the PNG.
  const png = readFileSync(shot.path);
  const box = (await commands.answer(ReticleCommand.INSPECT, { ref: window.ref })).box;
  const scale = png.readUInt32BE(16) / box.width;
  const px = (fx, fy) => ({
    x: Math.round(box.width * fx * scale),
    y: Math.round(box.height * fy * scale),
  });
  const stroke = await act(window.ref, ActionType.DRAG, {
    foreground: true,
    path: [px(0.35, 0.45), px(0.5, 0.6), px(0.65, 0.45)],
  });
  assert.ok(
    stroke.effect.pixelsChanged > 0 || stroke.effect.domMutatedWithin > 0,
    `the stroke showed no effect: ${JSON.stringify(stroke.effect)}`,
  );
  process.stdout.write(`ok  the stroke: ${JSON.stringify(stroke.effect)}\n`);
  passed += 1;

  const before = statSync(photo).mtimeMs;
  await menu('File', 'Save');
  await sleep(1500);
  assert.ok(statSync(photo).mtimeMs > before, 'the photo was not saved');
  assert.equal(size(), '400x600', 'the saved photo is not turned');
  assert.ok(strokePixels() > strokeBefore, 'the saved photo has no stroke');
  passed += 1;
  process.stdout.write(`computer-use photocheck: ${passed} of 4 edits proved in the file\n`);
} finally {
  // Not AppleScript: asking Preview by script waits on a consent dialog for the terminal.
  process.kill(pidOf(), 'SIGTERM');
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
