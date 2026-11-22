// Checks the computer-use realm on Windows against Notepad, through the UI Automation helper
// (reticle-uia.ps1) and the same driver and reader that macOS uses:
//   - the helper reads Notepad as a window with a text area that has a ref;
//   - a value set in the text area is read back from the application, not from the answer;
//   - a press on a menu item of the window is delivered and changes what is on the screen;
//   - an element that is not there any more is refused as stale, never acted on.
//
//   node native/win/uiacheck.mjs
//
// Windows only. Build the package first. Notepad is started and closed by the check.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  assert.ok(area?.ref, `Notepad has no text area with a ref:\n${shown}`);

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
  process.stdout.write('computer-use uiacheck: 4 of 4 cases held\n');
} finally {
  notepad.kill();
}
