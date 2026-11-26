// Checks what the person at the machine sees: the window of the realm shows the action and its
// effect, and Pause in that window stops the realm. The check presses Pause the way a person
// does: a second realm reads the window and presses its button.
//
//   node native/mac/hudcheck.mjs
//
// Needs the Accessibility permission. Build the package first.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  ActionType,
  EventType,
  PresenterTone,
  ReticleCommand,
  SessionState,
} from '@reticlehq/core';

import { HUMAN_DONE, MacDriver, PeerCommands, macHud } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const [name, to] of [
  ['reticle-ax', 'reticle-ax'],
  ['fixture', 'fixture'],
  ['hud', 'reticle-hud'],
]) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${to}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

// Where the pointer of the HUD is: its window is the one at the level of a screen saver (1000).
writeFileSync(
  `${build}/hudwins.swift`,
  `import CoreGraphics
let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in all where (w[kCGWindowOwnerName as String] as? String) == "reticle-hud" && (w[kCGWindowLayer as String] as? Int) == 1000 {
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  print(Int(b["X"] ?? 0), Int(b["Y"] ?? 0))
}
`,
);
execFileSync('swiftc', ['-O', `${build}/hudwins.swift`, '-o', `${build}/hudwins`], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
const pointerAt = () => execFileSync(`${build}/hudwins`, { encoding: 'utf8' }).trim();

// Only this check may read the window of Reticle: it presses Pause as a person does.
process.env.RETICLE_AX_CHECKS_ITS_OWN_WINDOW = '1';
const helper = `${build}/reticle-ax`;
const fixture = spawn(`${build}/fixture`, [tmpdir()], { stdio: 'ignore' });
const hud = macHud(`${build}/reticle-hud`);
const said = [];
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: 'fixture', pid: fixture.pid }),
  emit: (type, data) => said.push([type, data]),
  hud,
});

async function press(peer, name) {
  const found = await peer.answer(ReticleCommand.QUERY, { role: 'button', name });
  assert.ok(found.elements[0], `no button named ${name}`);
  return peer.answer(ReticleCommand.ACT, {
    ref: found.elements[0].ref,
    action: ActionType.CLICK,
    args: { settleMs: 500 },
  });
}

try {
  await sleep(1500);
  await press(commands, 'Save');
  await sleep(300);
  const atSave = pointerAt();

  const hudPid = Number(execFileSync('pgrep', ['-n', '-f', 'build/reticle-hud']).toString().trim());
  const onHud = new PeerCommands({
    driver: new MacDriver({ helper, app: 'reticle-hud', pid: hudPid }),
    emit: () => undefined,
  });
  // At rest the HUD is one circle, as in a browser. A press opens it.
  const atRest = (await onHud.answer(ReticleCommand.SNAPSHOT, {})).tree;
  assert.ok(!atRest.includes('"Pause"'), 'the HUD was open before anybody opened it');
  await press(onHud, 'Open Reticle');
  await sleep(300);
  const window = (await onHud.answer(ReticleCommand.SNAPSHOT, {})).tree;
  // The action is shown with its quotes, and the tree writes a quote in a name with a mark
  // before it. So the words are looked for without the quotes.
  for (const words of ['text "fixture"', 'press button', '2 change(s)']) {
    assert.ok(window.includes(words), `the window does not show: ${words}`);
  }

  await press(onHud, 'Pause');
  await sleep(400);
  await assert.rejects(press(commands, 'Slow'), /paused Reticle/);
  await press(onHud, 'Resume');
  await sleep(400);
  const after = await press(commands, 'Slow');
  assert.ok(after.effect.domMutatedWithin > 0, 'the realm did not act after Resume');
  const status = (await commands.answer(ReticleCommand.QUERY, { role: 'text' })).elements[0]?.name;
  assert.equal(status, 'Slow done');
  // The pointer goes to each control the realm presses. An animated setFrameOrigin did nothing,
  // so a pointer that was already on the screen stayed at its first place for the whole run.
  await sleep(300);
  assert.ok(atSave !== '' && pointerAt() !== atSave, `the pointer did not move: ${atSave}`);

  // A drag from one point of a picture to another: the pointer presses at the middle of the pad
  // and lets go 30 points to the right, as a hand drags. It stayed at the start after the drag.
  const pad = (await commands.answer(ReticleCommand.QUERY, { role: 'button', name: 'Pad' }))
    .elements[0].ref;
  const win = (await commands.answer(ReticleCommand.QUERY, { role: 'window' })).elements[0].ref;
  const shot = await commands.answer(ReticleCommand.CAPTURE, {});
  const windowBox = (await commands.answer(ReticleCommand.INSPECT, { ref: win })).box;
  const scale = readFileSync(shot.path).readUInt32BE(16) / windowBox.width;
  rmSync(shot.path, { force: true });
  const { box } = await commands.answer(ReticleCommand.INSPECT, { ref: pad });
  const point = {
    x: (box.x + box.width / 2 - windowBox.x) * scale,
    y: (box.y + box.height / 2 - windowBox.y) * scale,
  };
  await commands.answer(ReticleCommand.ACT, { ref: pad, action: ActionType.CLICK, args: {} });
  await sleep(300);
  const [fromX] = pointerAt().split(' ').map(Number);
  await commands.answer(ReticleCommand.ACT, {
    ref: win,
    action: ActionType.DRAG,
    args: {
      foreground: true,
      point,
      toPoint: { x: point.x + 30 * scale, y: point.y },
      settleMs: 500,
    },
  });
  await sleep(300);
  const [toX] = pointerAt().split(' ').map(Number);
  assert.ok(
    Math.abs(toX - fromX - 30) <= 3,
    `the pointer did not follow the drag: ${fromX} to ${toX}`,
  );

  // The person's turn: the agent's `yield` with a question. The HUD shows it, and Pause becomes
  // Done. Done goes back to the agent as the person's message, and Done is Pause again.
  await commands.answer(ReticleCommand.PRESENTER, {
    state: SessionState.ENDED,
    tone: PresenterTone.ASK,
    text: 'Type the code',
  });
  await sleep(400);
  const asking = (await onHud.answer(ReticleCommand.SNAPSHOT, {})).tree;
  assert.ok(asking.includes('Your turn: Type the code'), 'the HUD does not show the question');
  await press(onHud, 'Done');
  await sleep(400);
  assert.ok(
    said.some(([type, data]) => type === EventType.HUMAN_CONTROL && data.text === HUMAN_DONE),
    'Done did not go back to the agent',
  );
  await press(onHud, 'Pause');
  await press(onHud, 'Resume');

  // The program of the HUD ends (it crashed, or it was quit): it is started again, and the
  // pointer is back at the next action. The pointer was gone for the rest of the session.
  execFileSync('kill', [String(hudPid)]);
  await sleep(1500);
  await press(commands, 'Save');
  await sleep(500);
  assert.notEqual(pointerAt(), '', 'the pointer did not come back after the HUD ended');
  const newHud = Number(execFileSync('pgrep', ['-n', '-f', 'build/reticle-hud']).toString().trim());
  const again = new PeerCommands({
    driver: new MacDriver({ helper, app: 'reticle-hud', pid: newHud }),
    emit: () => undefined,
  });

  // Stop ends it: no action after it, also not after a time.
  await press(again, 'Open Reticle');
  await sleep(300);
  await press(again, 'Stop');
  await sleep(400);
  await assert.rejects(press(commands, 'Save'), /stopped Reticle/);
  assert.equal(hud.stopped(), true);

  process.stdout.write('computer hudcheck: 11 of 11 cases held\n');
} finally {
  hud.close();
  fixture.kill();
}
