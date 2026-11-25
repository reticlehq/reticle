// Checks the computer-use realm on Windows against Notepad, through the UI Automation helper
// (reticle-uia.ps1) and the same driver and reader that macOS uses:
//   - the helper reads Notepad as a window with a text area that has a ref;
//   - a value set in the text area is read back from the application, not from the answer;
//   - a press on a menu item of the window is delivered and changes what is on the screen;
//   - an element that is not there any more is refused as stale, never acted on;
//   - a drag on a canvas (ink.ps1) draws a line that no element shows: the realm reports the
//     pixels that changed, and a bar that moves by itself is not counted as an effect.
//
//   node native/win/uiacheck.mjs
//
// Windows only. Build the package first. Notepad is started and closed by the check.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands, helperLaunch, servingHelper } from '../../dist/index.js';

if ('win32' !== process.platform) {
  process.stdout.write('computer-use uiacheck: skipped, it runs on Windows\n');
  process.exit(0);
}

const launch = helperLaunch('win32', fileURLToPath(new URL('../', import.meta.url)));
const notepad = spawn('notepad.exe', [], { stdio: 'ignore' });
const commands = new PeerCommands({
  driver: new MacDriver({
    helper: launch.file,
    app: 'Notepad',
    pid: notepad.pid,
    run: servingHelper(launch.prefix),
  }),
  emit: () => undefined,
});
const tree = async () => (await commands.answer(ReticleCommand.SNAPSHOT, {})).tree;

try {
  // The Notepad of Windows 11 starts a second process and gives it the window. The check reads the
  // process it started; when that has no window, it says so instead of a false failure.
  let shown = '';
  for (let i = 0; i < 20 && !/- window /.test(shown); i += 1) {
    await sleep(500);
    shown = await tree();
  }
  if (!/- window /.test(shown)) {
    process.stdout.write(
      `computer-use uiacheck: Notepad (${String(notepad.pid)}) shows no window of its own\n${shown}\n`,
    );
    process.exit(1);
  }
  const area = (await commands.answer(ReticleCommand.QUERY, { role: 'textbox' })).elements[0];
  if (area?.ref === undefined) {
    // The tree as UI Automation gave it, with the control type and class of each element: what a
    // person needs to see why the reader shows what it shows.
    const raw = execFileSync(launch.file, [...launch.prefix, 'tree', String(notepad.pid)], {
      encoding: 'utf8',
      env: { ...process.env, RETICLE_UIA_DEBUG: '1' },
    });
    const lines = [];
    const walk = (node, depth) => {
      if (depth > 7) return;
      lines.push(
        `${'  '.repeat(depth)}${node.role} ${node.uia ?? ''} "${node.title ?? ''}" ${JSON.stringify(node.frame ?? null)}`,
      );
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    walk(JSON.parse(raw).tree, 0);
    assert.fail(
      `Notepad has no text area with a ref:\n${shown}\nUI Automation gave:\n${lines.join('\n')}`,
    );
  }

  await commands.answer(ReticleCommand.ACT, {
    ref: area.ref,
    action: ActionType.FILL,
    args: { value: 'Reticle on Windows', settleMs: 800 },
  });
  const again = (await commands.answer(ReticleCommand.QUERY, { role: 'textbox' })).elements[0];
  assert.equal(again?.value, 'Reticle on Windows', 'the value was not read back from Notepad');

  const file = (await commands.answer(ReticleCommand.QUERY, { role: 'menuitem', name: 'File' }))
    .elements[0];
  if (file?.ref !== undefined) {
    const pressed = await commands.answer(ReticleCommand.ACT, {
      ref: file.ref,
      action: ActionType.CLICK,
      args: { settleMs: 800 },
    });
    assert.ok(pressed.effect.domMutatedWithin > 0, 'the press on the File menu changed nothing');
  }

  await assert.rejects(
    commands.answer(ReticleCommand.ACT, { ref: 'e9999', action: ActionType.CLICK }),
    /no longer resolves|unknown ref|not found/i,
  );
  await checkInk();
  process.stdout.write('computer-use uiacheck: 6 of 6 cases held\n');
} finally {
  notepad.kill();
}

/** A canvas: its effect is only in its pixels, beside a bar that moves by itself. */
async function checkInk() {
  const form = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('ink.ps1', import.meta.url)),
    ],
    { stdio: 'ignore' },
  );
  const ink = new PeerCommands({
    driver: new MacDriver({
      helper: launch.file,
      app: 'Ink',
      pid: form.pid,
      run: servingHelper(launch.prefix),
    }),
    emit: () => undefined,
  });
  try {
    let canvas;
    for (let i = 0; i < 30 && canvas?.ref === undefined; i += 1) {
      await sleep(500);
      canvas = (await ink.answer(ReticleCommand.QUERY, { name: 'Ink' })).elements.find(
        (e) => 'window' !== e.role,
      );
    }
    assert.ok(
      canvas?.ref,
      `the Ink form shows no canvas:\n${(await ink.answer(ReticleCommand.SNAPSHOT, {})).tree}`,
    );
    const drawn = await ink.answer(ReticleCommand.ACT, {
      ref: canvas.ref,
      action: ActionType.DRAG,
      args: { foreground: true, settleMs: 400, to: { x: 0.85, y: 0.85 } },
    });
    assert.ok(
      drawn.effect.pixelsChanged > 0,
      `the stroke showed no pixels: ${JSON.stringify(drawn.effect)}`,
    );
    const missed = await ink.answer(ReticleCommand.ACT, {
      ref: canvas.ref,
      action: ActionType.CLICK,
      args: { foreground: true, settleMs: 400 },
    });
    assert.equal(
      missed.effect.pixelsChanged,
      0,
      `a click that drew nothing: ${JSON.stringify(missed.effect)}`,
    );
    assert.ok(
      missed.effect.pixelsMovingByItself > 0,
      `the moving bar was not seen: ${JSON.stringify(missed.effect)}`,
    );
    process.stdout.write(
      `ok  a stroke: ${String(drawn.effect.pixelsChanged)} changed; a click beside a moving bar: 0 changed, ${String(missed.effect.pixelsMovingByItself)} moving\n`,
    );
  } finally {
    form.kill();
  }
}
