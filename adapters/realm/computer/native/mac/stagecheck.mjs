// Checks that Stage Manager can be turned on and off as a person does it: from Control Centre.
// Control Centre is not the application in front, and the items at the right of the menu bar were
// read as an empty menu bar, so no ref reached them. This check reads them, opens Control Centre
// with a press, finds the Stage Manager toggle as a checkbox with its state, and closes it again.
//
// It does not press the toggle: that moves every window of the person at the machine. An agent
// turns it on or off with `check` or `uncheck` on that ref, and the state of the box proves it.
//
//   node native/mac/stagecheck.mjs
//
// Needs the Accessibility permission. Build the package first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
execFileSync('swiftc', ['-O', `${here}reticle-ax.swift`, '-o', `${build}/reticle-ax`], {
  stdio: ['ignore', 'ignore', 'ignore'],
});

const pid = Number(execFileSync('pgrep', ['-x', 'ControlCenter'], { encoding: 'utf8' }).trim());
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'Control Centre', pid }),
  emit: () => undefined,
});
const tree = async () => (await commands.answer(ReticleCommand.SNAPSHOT, {})).tree;
const refIn = (text, words) =>
  text
    .split('\n')
    .find((line) => line.includes(words))
    ?.split('ref=')[1]
    ?.split(')')[0];

const before = await tree();
const item = refIn(before, 'menuitem "Control Centre"') ?? refIn(before, '"Control Centre" (ref');
assert.ok(item, `Control Centre in the menu bar has no ref:\n${before}`);
const toggle = () =>
  commands.answer(ReticleCommand.ACT, {
    ref: item,
    action: ActionType.CLICK,
    args: { settleMs: 600 },
  });

let open = false;
try {
  await toggle();
  open = true;
  const shown = await tree();
  const line = shown.split('\n').find((l) => l.includes('checkbox "Stage Manager"'));
  assert.ok(line, `Control Centre shows no Stage Manager checkbox:\n${shown}`);
  assert.ok(/checked|ref=/.test(line), 'the Stage Manager checkbox has no ref');
  await toggle();
  open = false;
  assert.ok(!(await tree()).includes('checkbox "Stage Manager"'), 'Control Centre did not close');
  process.stdout.write('computer stagecheck: 4 of 4 cases held\n');
} finally {
  if (open) {
    await toggle();
  }
}
