// Does a piece of office work in Numbers, as a person does, and proves it in the exported file:
// the realm opens a sheet of costs, changes a price, adds a row with a total as a formula, and
// exports the sheet as CSV into a folder it chooses. The total must be the one Numbers computed.
//
// Numbers gives its sheet only to a screen reader: with no switch, the sheet is an empty scroll
// area. The driver tries that switch at its first read that shows a window, as the join makes it.
//
//   node native/mac/numberscheck.mjs
//
// IT TAKES THE POINTER AND THE KEYBOARD for some seconds. Needs the Accessibility permission.
// Build the package first. Does not run if Numbers is open already: its windows belong to the person.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const APP = 'Numbers';
const helper = `${fileURLToPath(new URL('.', import.meta.url))}build/reticle-ax`;
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if (0 !== pidOf()) {
  process.stdout.write('computer numberscheck: skipped, Numbers is open already\n');
  process.exit(0);
}

// realpath: the save panel names /private/var, and the folder must be the same text.
const dir = execFileSync('realpath', [mkdtempSync(`${tmpdir()}/reticle-numbers-`)], {
  encoding: 'utf8',
}).trim();
writeFileSync(`${dir}/costs.csv`, 'Item,Price\nPens,12\nPaper,30\nInk,58\n');
const exported = `${dir}/export.csv`;

// No window of the last time: a sheet that Numbers brings back is not this check's sheet.
execFileSync('open', ['-g', '-a', APP, '--args', '-ApplePersistenceIgnoreState', 'YES']);
await sleep(1500);
execFileSync('open', ['-g', '-a', APP, `${dir}/costs.csv`]);
await sleep(5000);
const pid = pidOf();
// As the join makes it: the driver tries the screen reader switch at its first read that shows a
// window.
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: APP, pid, screenReaderSwitch: true }),
  emit: () => undefined,
});
const find = async (query) => (await commands.answer(ReticleCommand.QUERY, query)).elements;
const act = async (ref, action, args = {}) =>
  commands.answer(ReticleCommand.ACT, { ref, action, args: { settleMs: 800, ...args } });
const app = async () => (await find({ role: 'application' }))[0].ref;
const cells = async () => find({ role: 'cell' });
const values = async () => (await cells()).map((cell) => cell.name.split(',')[0]);
/** A cell chosen, and not open for editing: a click on a chosen cell opens it at the pointer. */
async function pick(index) {
  await act((await cells())[index].ref, ActionType.CLICK, { foreground: true });
  if (/Is Editing/.test((await cells())[index].name)) {
    await act(await app(), ActionType.PRESS, { text: 'Escape', foreground: true });
  }
}
/** Keys go to the application in front, as a person types: the cell changes its name as it opens. */
async function enter(text) {
  await act(await app(), ActionType.TYPE, { text, foreground: true });
  await act(await app(), ActionType.PRESS, { text: 'Return', foreground: true });
}

let passed = 0;
try {
  // Opened in the background, the window can be off the screen (in the strip of Stage Manager):
  // bring Numbers to the front, as a person clicks it there.
  await act(await app(), ActionType.FOCUS, { foreground: true });
  assert.deepEqual((await values()).slice(0, 8), [
    'Item',
    'Price',
    'Pens',
    '12',
    'Paper',
    '30',
    'Ink',
    '58',
  ]);
  passed += 1;

  await pick(3);
  await enter('15');
  assert.equal((await values())[3], '15', `the price is ${(await values())[3]}`);
  passed += 1;

  // A row below the last one (Option-Down), and in its empty cell the total as a formula.
  await pick(7);
  await act(await app(), ActionType.PRESS, { text: 'Alt+ArrowDown', foreground: true });
  assert.equal((await cells()).length, 10, 'no row was added');
  await pick(9);
  await enter('=SUM(B2:B4)');
  const total = (await cells())[9].name;
  assert.match(total, /^103,.*Formula result/, `the total is ${total}`);
  passed += 1;

  // The export: the menu bar is on the screen only when Numbers is in front.
  await act(await app(), ActionType.FOCUS, { foreground: true });
  await act((await find({ role: 'menuitem', name: 'File' })).at(-1).ref, ActionType.CLICK);
  await act((await find({ role: 'menuitem', name: 'Export To' }))[0].ref, ActionType.CLICK);
  await act((await find({ role: 'menuitem', name: 'CSV…' }))[0].ref, ActionType.CLICK);
  await sleep(1000);
  const include = (await find({ role: 'checkbox', name: 'Include table names' }))[0];
  if (include?.states?.includes('checked')) {
    await act(include.ref, ActionType.CLICK);
  }
  await act((await find({ role: 'button', name: 'Save…' }))[0].ref, ActionType.CLICK);
  await sleep(1000);
  const [name] = await find({ by: 'testid', value: 'saveAsNameTextField' });
  assert.ok(name, 'the save panel was not read');
  // The panel opens in the folder it used last. Go to the check's own folder, as a person does.
  await act(name.ref, ActionType.PRESS, { text: 'Meta+Shift+g', foreground: true });
  const goTo = (await find({ role: 'textbox' })).find((box) => String(box.value).startsWith('/'));
  assert.ok(goTo, 'the "Go to folder" sheet did not open');
  await act(goTo.ref, ActionType.FILL, { value: `${dir}/` });
  await sleep(500);
  await act(goTo.ref, ActionType.PRESS, { text: 'Return', foreground: true });
  const [where] = await find({ role: 'combobox', name: 'Where:' });
  assert.ok(String(where?.value).includes(dir.split('/').at(-1)), `the folder is ${where?.value}`);
  await act(name.ref, ActionType.FILL, { value: 'export' });
  await act((await find({ role: 'button', name: 'Export' })).at(-1).ref, ActionType.CLICK);
  for (let waited = 0; waited < 20 && !existsSync(exported); waited += 1) {
    await sleep(500);
  }
  const csv = existsSync(exported) ? readFileSync(exported, 'utf8') : '';
  assert.match(csv, /Pens,15/, `the export is:\n${csv}`);
  assert.match(csv, /,103\b/, `the export has no total:\n${csv}`);
  passed += 1;
  process.stdout.write(
    `computer numberscheck: ${passed} of 4 steps proved, the total in the file is 103\n`,
  );
} finally {
  if (0 !== pidOf()) {
    process.kill(pidOf(), 'SIGTERM');
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
