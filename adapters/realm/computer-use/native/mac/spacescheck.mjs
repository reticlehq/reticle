// Checks the desktops of macOS through Mission Control, on the real machine. The realm sends
// Control+Up as a person does, the Dock (which holds Mission Control) shows its Spaces Bar with a
// button for each desktop and the "add desktop" button, and a second Control+Up closes it.
//
// With those buttons a person switches desktops (a press on one), adds one ("add desktop"), and
// moves a window to another desktop (a drag of its button onto the desktop, `toRef`). This check
// opens and reads only: it does not change the desktops of the person at the machine, and it
// prints no name of a window.
//
//   node native/mac/spacescheck.mjs
//
// Needs the Accessibility permission. Build the package first. It takes the screen for a moment.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
execFileSync('swiftc', ['-O', `${here}reticle-ax.swift`, '-o', `${build}/reticle-ax`], {
  stdio: ['ignore', 'ignore', 'ignore'],
});

// The modifiers the system holds now. A key posted with flags left Control, Fn and the number pad
// held after Control+Up, and every key typed after it on the machine was a Control key.
writeFileSync(
  `${build}/heldflags.swift`,
  `import CoreGraphics
let f = CGEventSource.flagsState(.combinedSessionState)
let held: [(String, CGEventFlags)] = [("control", .maskControl), ("fn", .maskSecondaryFn), ("numpad", .maskNumericPad), ("shift", .maskShift), ("command", .maskCommand), ("option", .maskAlternate)]
print(held.filter { f.contains($0.1) }.map { $0.0 }.joined(separator: ","))
`,
);
execFileSync('swiftc', ['-O', `${build}/heldflags.swift`, '-o', `${build}/heldflags`], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
const heldNow = () => execFileSync(`${build}/heldflags`, { encoding: 'utf8' }).trim();

const pid = Number(execFileSync('pgrep', ['-x', 'Dock'], { encoding: 'utf8' }).trim());
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'Dock', pid }),
  emit: () => undefined,
  foreground: true,
});
const tree = async () => (await commands.answer(ReticleCommand.SNAPSHOT, {})).tree;
const refIn = (text, words) =>
  text
    .split('\n')
    .find((line) => line.includes(words))
    ?.split('ref=')[1]
    ?.split(')')[0];
const missionControl = async () =>
  commands.answer(ReticleCommand.ACT, {
    ref: refIn(await tree(), '- application'),
    action: ActionType.PRESS,
    args: { text: 'ArrowUp', modifiers: ['Control'], foreground: true, settleMs: 1200 },
  });

let open = false;
try {
  await missionControl();
  open = true;
  const shown = await tree();
  assert.ok(shown.includes('group "Mission Control"'), 'Control+Up did not open Mission Control');
  assert.ok(shown.includes('group "Spaces Bar"'), 'Mission Control shows no Spaces Bar');
  assert.ok(shown.includes('button "add desktop"'), 'there is no button to add a desktop');
  assert.ok(/button "Desktop \d+"/.test(shown), 'the Spaces Bar has no desktop');

  await missionControl();
  open = false;
  assert.ok(!(await tree()).includes('group "Mission Control"'), 'Mission Control did not close');
  assert.equal(heldNow(), '', 'a modifier is still held after the shortcut');

  process.stdout.write('computer-use spacescheck: 6 of 6 cases held\n');
} finally {
  if (open) {
    await missionControl();
  }
}
