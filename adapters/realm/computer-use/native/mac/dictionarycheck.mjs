// Checks the realm against the system Dictionary: a field, a Return, and a page of results.
//   - the search field takes a word;
//   - Dictionary puts the field in another group of its window when it shows results, and the
//     ref of the field must go with it: the Return after the fill uses the same ref;
//   - the heading of the entry is read.
// Dictionary writes no file and has no account.
//
//   node native/mac/dictionarycheck.mjs
//
// Needs the Accessibility permission. Build the package first. The screen goes to Dictionary
// for the time of the check. It does not run when Dictionary is open already.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const APP = 'Dictionary';
const WORD = 'reticle';
const helper = `${fileURLToPath(new URL('.', import.meta.url))}build/reticle-ax`;
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if (0 !== pidOf()) {
  process.stdout.write('computer-use dictionarycheck: skipped, Dictionary is open already\n');
  process.exit(0);
}
execFileSync('open', ['-a', APP]);
let pid = 0;
for (let tries = 0; tries < 40 && 0 === pid; tries += 1) {
  await sleep(250);
  pid = pidOf();
}
assert.ok(0 !== pid, 'Dictionary did not start');
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: APP, pid }),
  emit: () => undefined,
});
const fields = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'textbox' })).elements;

try {
  let field;
  for (let tries = 0; tries < 40 && field === undefined; tries += 1) {
    await sleep(250);
    [field] = await fields();
  }
  assert.ok(field, 'Dictionary shows no search field');
  await commands.answer(ReticleCommand.ACT, {
    ref: field.ref,
    action: ActionType.FILL,
    args: { value: WORD },
  });
  const [after] = await fields();
  assert.equal(after?.value, WORD, 'the field does not hold the word');
  assert.equal(after?.ref, field.ref, 'the field has another ref after the fill');
  await commands.answer(ReticleCommand.ACT, { ref: field.ref, action: ActionType.SUBMIT });
  let headings = [];
  for (let tries = 0; tries < 20 && 0 === headings.length; tries += 1) {
    await sleep(250);
    headings = (await commands.answer(ReticleCommand.QUERY, { role: 'heading' })).elements.filter(
      (e) => WORD === e.name.toLowerCase(),
    );
  }
  assert.ok(headings.length > 0, 'the entry for the word was not read');
  process.stdout.write('computer-use dictionarycheck: the word was looked up, with one ref\n');
} finally {
  process.kill(pid);
}
