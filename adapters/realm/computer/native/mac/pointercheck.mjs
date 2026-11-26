// Checks the real pointer against the fixture application, through the peer: a click, a
// double-click, a right-click, a drag and a hover, each asked for with `foreground: true`. And a
// picture of the window, with a click at a point of it.
//
//   node native/mac/pointercheck.mjs
//
// IT TAKES THE POINTER for a few seconds, and puts it back. Needs the Accessibility permission.
// Build the package first. Do not move the pointer while it runs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
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

const fixture = spawn(`${build}/fixture`, [tmpdir()], { stdio: 'ignore' });
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid }),
  emit: () => undefined,
});

const pad = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'button', name: 'Pad' })).elements[0];
const status = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'text' })).elements[0]?.name;
/** One gesture on the pad, and the words the pad then shows. */
async function gesture(action, args) {
  await commands.answer(ReticleCommand.ACT, {
    ref: (await pad()).ref,
    action,
    args: { settleMs: 700, ...args },
  });
  return status();
}

try {
  await sleep(1500);
  // Without the foreground, the realm does not take the pointer, and it says how to ask.
  await assert.rejects(gesture(ActionType.DBLCLICK), /foreground: true/);

  assert.equal(await gesture(ActionType.CLICK, { foreground: true }), 'Pad: click');
  assert.equal(await gesture(ActionType.DBLCLICK, { foreground: true }), 'Pad: double');
  assert.equal(
    await gesture(ActionType.CLICK, { foreground: true, button: 'right' }),
    'Pad: right',
  );
  const { box } = await commands.answer(ReticleCommand.INSPECT, { ref: (await pad()).ref });
  // `to` is a fraction of the element's box, as in a page: 30 points right of the middle.
  const to = { x: 0.5 + 30 / box.width, y: 0.5 };
  assert.equal(await gesture(ActionType.DRAG, { foreground: true, to }), 'Pad: dragged 30');
  // A hover leaves the pointer where it is. So the pointer is first put on another control: a
  // pointer that is on the pad already does not come in again.
  const save = await commands.answer(ReticleCommand.QUERY, { role: 'button', name: 'Save' });
  await commands.answer(ReticleCommand.ACT, {
    ref: save.elements[0]?.ref,
    action: ActionType.HOVER,
    args: { foreground: true, settleMs: 300 },
  });
  assert.equal(await gesture(ActionType.HOVER, { foreground: true }), 'Pad: hover');

  // A picture of the window, and a click at a point of it: the way to act on an application that
  // gives no elements. The pad is found here by its place in the picture, not by its ref.
  const window = (await commands.answer(ReticleCommand.QUERY, { role: 'window' })).elements[0];
  const shot = await commands.answer(ReticleCommand.CAPTURE, {});
  assert.equal(shot.ok, true, `no picture: ${String(shot.reason)}`);
  const png = readFileSync(shot.path);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const windowBox = (await commands.answer(ReticleCommand.INSPECT, { ref: window.ref })).box;
  const scale = png.readUInt32BE(16) / windowBox.width;
  const padBox = (await commands.answer(ReticleCommand.INSPECT, { ref: (await pad()).ref })).box;
  const at = {
    x: (padBox.x + padBox.width / 2 - windowBox.x) * scale,
    y: (padBox.y + padBox.height / 2 - windowBox.y) * scale,
  };
  await commands.answer(ReticleCommand.ACT, {
    ref: window.ref,
    action: ActionType.DBLCLICK,
    args: { foreground: true, point: at, settleMs: 700 },
  });
  assert.equal(await status(), 'Pad: double');
  // With a point, the point is the target, and the ref only names the window. The middle of the
  // ref's element can be under a view: a hover at the edge of Dia was refused because the middle
  // of the window was under its sidebar.
  const covered = await commands.answer(ReticleCommand.QUERY, { role: 'button', name: 'Covered' });
  await commands.answer(ReticleCommand.ACT, {
    ref: covered.elements[0]?.ref,
    action: ActionType.CLICK,
    args: { foreground: true, point: at, settleMs: 700 },
  });
  assert.equal(await status(), 'Pad: click');
  // A drag from one point of the picture to another, with no element at either end named: the
  // way to move a thing that gives no element, as a window in Mission Control.
  await commands.answer(ReticleCommand.ACT, {
    ref: window.ref,
    action: ActionType.DRAG,
    args: {
      foreground: true,
      point: at,
      toPoint: { x: at.x + 40 * scale, y: at.y },
      settleMs: 700,
    },
  });
  assert.equal(await status(), 'Pad: dragged 40');
  // A drag along a path of the picture, through a point below the line: a brush stroke, not a
  // straight line. It ends 40 points to the right, with Shift held through it.
  await commands.answer(ReticleCommand.ACT, {
    ref: window.ref,
    action: ActionType.DRAG,
    args: {
      foreground: true,
      path: [at, { x: at.x + 20 * scale, y: at.y + 10 * scale }, { x: at.x + 40 * scale, y: at.y }],
      modifiers: ['Shift'],
      settleMs: 700,
    },
  });
  assert.equal(await status(), 'Pad: dragged 40');
  // The wheel turned at a point of the picture: a list of a web view that has no scroll bar is
  // scrolled where the pointer is, and the ref only names the window.
  await commands.answer(ReticleCommand.ACT, {
    ref: window.ref,
    action: ActionType.SCROLL,
    args: { foreground: true, point: at, dy: 200, settleMs: 700 },
  });
  assert.equal(await status(), 'Pad: wheel down');
  // Sideways: a wide table, a timeline.
  await commands.answer(ReticleCommand.ACT, {
    ref: window.ref,
    action: ActionType.SCROLL,
    args: { foreground: true, point: at, dx: 200, settleMs: 700 },
  });
  assert.equal(await status(), 'Pad: wheel right');
  rmSync(shot.path, { force: true });

  // A long press: the pad says "long" when the button was down 400 ms or more.
  assert.equal(await gesture(ActionType.CLICK, { foreground: true, holdMs: 600 }), 'Pad: long');
  // A triple-click, which chooses a line or a paragraph, and the middle button.
  assert.equal(await gesture(ActionType.CLICK, { foreground: true, clickCount: 3 }), 'Pad: triple');
  assert.equal(
    await gesture(ActionType.CLICK, { foreground: true, button: 'middle' }),
    'Pad: middle',
  );

  process.stdout.write('computer pointercheck: 16 of 16 cases held\n');
} finally {
  fixture.kill();
}
