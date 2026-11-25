// Checks that the realm sees an effect that is only in pixels: a drag on the fixture's Ink canvas
// draws a line and changes no element. Before this, the realm said "nothing changed" for it, and
// a model drew the line again. A click on a button that does nothing must show no pixel change.
//
//   node native/mac/pixelcheck.mjs
//
// IT TAKES THE POINTER for a few seconds, and puts it back. Needs the Accessibility and Screen
// Recording permissions. Build the package first. Do not move the pointer while it runs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands, PIXELS_CHANGED_SIGNAL } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const fixture = spawn(`${build}/fixture`, [tmpdir()], { stdio: 'ignore' });
const signals = [];
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid }),
  emit: (type, data) => signals.push([type, data]),
});
const find = async (role, name) =>
  (await commands.answer(ReticleCommand.QUERY, { role, name })).elements[0];

try {
  await sleep(1500);
  const ink = (await commands.answer(ReticleCommand.QUERY, { name: 'Ink' })).elements[0];
  assert.ok(ink, 'the fixture shows no Ink canvas');
  const { box } = await commands.answer(ReticleCommand.INSPECT, { ref: ink.ref });
  const drawn = await commands.answer(ReticleCommand.ACT, {
    ref: ink.ref,
    action: ActionType.DRAG,
    args: { foreground: true, settleMs: 400, to: { x: 0.85, y: 0.85 } },
  });
  assert.equal(drawn.effect.domMutatedWithin, 0, 'the stroke changed an element');
  assert.ok(drawn.effect.pixelsChanged > 0, `no pixels changed: ${JSON.stringify(drawn.effect)}`);
  assert.equal(drawn.effect.note, undefined);
  const signal = signals.find(([, data]) => data?.name === PIXELS_CHANGED_SIGNAL)?.[1];
  assert.ok(signal, 'no pixels.changed signal');
  // The box of the change lies on the canvas, with a few points for the stroke's width.
  const [x, y, w, h] = signal.data.box;
  const near = (inner, outer, size) => inner >= outer - 6 && inner <= outer + size + 6;
  assert.ok(near(x, box.x, box.width) && near(y, box.y, box.height), `box ${signal.data.box}`);
  assert.ok(
    near(x + w, box.x, box.width) && near(y + h, box.y, box.height),
    `box ${signal.data.box}`,
  );
  console.log(
    `ok  a stroke on a canvas: ${drawn.effect.pixelsChanged} of the window, box ${signal.data.box}`,
  );

  const dead = await find('button', 'Dead');
  const pressed = await commands.answer(ReticleCommand.ACT, {
    ref: dead.ref,
    action: ActionType.CLICK,
    args: { foreground: true, settleMs: 400 },
  });
  assert.ok((pressed.effect.pixelsChanged ?? 0) < 0.002, JSON.stringify(pressed.effect));
  console.log(`ok  a button that does nothing: ${pressed.effect.pixelsChanged ?? 0} changed`);
} finally {
  fixture.kill();
}
