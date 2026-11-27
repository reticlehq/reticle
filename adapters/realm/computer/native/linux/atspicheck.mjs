// Checks the computer realm on Linux against a GTK application (fixture.py), through the AT-SPI
// helper (reticle-atspi.py) and the same driver and reader that macOS and Windows use:
//   - the helper reads the application as a window with a field that has a ref;
//   - a value set in the field is read back from the application, not from the answer;
//   - a press on the Save button is delivered, and the status text then says what was saved;
//   - keys in the background reach the field, and the person's keyboard is not used;
//   - a click on the check box with the real pointer checks it;
//   - an element that is not there any more is refused as stale, never acted on;
//   - a drag on the canvas draws a line that no element shows: the realm reports the pixels that
//     changed, and a bar that moves by itself is not counted as an effect;
//   - the window takes a frame and a half of the screen, and the answer is its new frame;
//   - a table of 600,000 cells (bigtable.py) is read in the time an act has: the cells on the
//     screen, with how many it left out, and a click on one of them reaches it;
//   - a button on a page that is not shown has no place, and a click on it is refused.
//
//   node native/linux/atspicheck.mjs
//
// Linux with an X display and the AT-SPI bus only (xvfb-run and dbus-run-session in CI). Build
// the package first. The fixture is started and closed by the check.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand, WindowArrangement } from '@reticlehq/core';

import { MacDriver, PeerCommands, helperLaunch, servingHelper } from '../../dist/index.js';

if ('linux' !== process.platform) {
  process.stdout.write('computer atspicheck: skipped, it runs on Linux\n');
  process.exit(0);
}

const launch = helperLaunch('linux', fileURLToPath(new URL('../', import.meta.url)));
const fixture = spawn('python3', [fileURLToPath(new URL('fixture.py', import.meta.url))], {
  stdio: 'inherit',
});
// The application by the name it gives the accessibility bus, as `reticle-computer --app` finds
// it. Not by the process that was started: on a CI runner `python3` started a second process, and
// that one held the window.
let pid;
for (let i = 0; i < 30 && pid === undefined; i += 1) {
  await sleep(500);
  const listed = JSON.parse(
    execFileSync(launch.file, [...launch.prefix, 'apps'], { encoding: 'utf8' }),
  ).apps;
  pid = listed.find((app) => 'fixture.py' === app.name)?.pid;
}
assert.ok(pid, 'the fixture did not join the accessibility bus');
const commands = new PeerCommands({
  driver: new MacDriver({
    helper: launch.file,
    app: 'fixture.py',
    pid,
    run: servingHelper(launch.prefix),
  }),
  emit: () => undefined,
});
const query = async (filter) => (await commands.answer(ReticleCommand.QUERY, filter)).elements;

let held = 0;
try {
  let shown = '';
  for (let i = 0; i < 30 && !/- window /.test(shown); i += 1) {
    await sleep(500);
    shown = (await commands.answer(ReticleCommand.SNAPSHOT, {})).tree;
  }
  assert.match(shown, /- window /, `the fixture shows no window:\n${shown}`);
  // A paragraph has no name: its words are its text, and the read shows them.
  assert.match(shown, /Words without a name/, `the paragraph shows no words:\n${shown}`);
  held += 1;

  const field = (await query({ role: 'textbox', name: 'Name' }))[0];
  assert.ok(field?.ref, `the field has no ref:\n${shown}`);
  await commands.answer(ReticleCommand.ACT, {
    ref: field.ref,
    action: ActionType.FILL,
    args: { value: 'Reticle on Linux', settleMs: 600 },
  });
  assert.equal((await query({ role: 'textbox', name: 'Name' }))[0]?.value, 'Reticle on Linux');
  held += 1;

  const save = (await query({ role: 'button', name: 'Save' }))[0];
  const pressed = await commands.answer(ReticleCommand.ACT, {
    ref: save.ref,
    action: ActionType.CLICK,
    args: { settleMs: 600 },
  });
  assert.ok(pressed.effect.domMutatedWithin > 0, 'the press on Save changed nothing');
  const said = await commands.answer(ReticleCommand.SNAPSHOT, {});
  assert.match(said.tree, /Saved: Reticle on Linux/, 'the status does not say what was saved');
  held += 1;

  // Keys in the background: to the window of the application alone, without the foreground.
  for (const key of ['End', 'Backspace']) {
    await commands.answer(ReticleCommand.ACT, {
      ref: (await query({ role: 'textbox', name: 'Name' }))[0].ref,
      action: ActionType.PRESS,
      args: { text: key, settleMs: 400 },
    });
  }
  assert.equal(
    (await query({ role: 'textbox', name: 'Name' }))[0]?.value,
    'Reticle on Linu',
    'two keys in the background did not reach the field',
  );
  held += 1;

  const remember = (await query({ role: 'checkbox', name: 'Remember' }))[0];
  const clicked = await commands.answer(ReticleCommand.ACT, {
    ref: remember.ref,
    action: ActionType.CLICK,
    args: { foreground: true, settleMs: 600 },
  });
  const box = (await query({ role: 'checkbox', name: 'Remember' }))[0];
  assert.ok(
    box?.states.includes('checked'),
    `the box is not checked: ${JSON.stringify(box)} ${JSON.stringify(clicked.effect)}`,
  );
  held += 1;

  await assert.rejects(
    commands.answer(ReticleCommand.ACT, { ref: 'e9999', action: ActionType.CLICK }),
    /no longer resolves|unknown ref|not found/i,
  );
  held += 1;

  const ink = (await query({ name: 'Ink' })).find((e) => 'window' !== e.role);
  assert.ok(ink?.ref, `the canvas has no ref:\n${shown}`);
  const drawn = await commands.answer(ReticleCommand.ACT, {
    ref: ink.ref,
    action: ActionType.DRAG,
    args: { foreground: true, settleMs: 400, to: { x: 0.85, y: 0.85 } },
  });
  assert.ok(
    drawn.effect.pixelsChanged > 0,
    `the stroke showed no pixels: ${JSON.stringify(drawn.effect)}`,
  );
  held += 1;
  const missed = await commands.answer(ReticleCommand.ACT, {
    ref: ink.ref,
    action: ActionType.CLICK,
    args: { foreground: true, settleMs: 400 },
  });
  assert.equal(missed.effect.pixelsChanged, 0, `a click drew: ${JSON.stringify(missed.effect)}`);
  assert.ok(
    missed.effect.pixelsMovingByItself > 0,
    `the moving bar was not seen: ${JSON.stringify(missed.effect)}`,
  );
  held += 1;

  // The window moves and takes a size, as a person arranges it, and the answer is its new frame.
  const win = (await query({ role: 'window' }))[0];
  const placed = await commands.answer(ReticleCommand.ACT, {
    ref: win.ref,
    action: ActionType.WINDOW,
    args: { frame: { x: 200, y: 150, width: 520, height: 380 } },
  });
  const { x, y, width, height } = placed.window ?? {};
  assert.deepEqual({ x, y, width, height }, { x: 200, y: 150, width: 520, height: 380 });
  const half = await commands.answer(ReticleCommand.ACT, {
    ref: (await query({ role: 'window' }))[0].ref,
    action: ActionType.WINDOW,
    args: { arrange: WindowArrangement.LEFT },
  });
  assert.equal(
    half.window?.x,
    0,
    `the left half is not at the left: ${JSON.stringify(half.window)}`,
  );
  assert.equal(
    half.window?.width,
    640,
    `the left half is not half: ${JSON.stringify(half.window)}`,
  );
  held += 1;
  // Last: a menu that was open can keep the keyboard of the window.
  // The helper does not read the items of a closed menu: each item is many calls on the bus.
  // LibreOffice has hundreds, and two reads of it took longer than the bridge waits for an act.
  const read = JSON.stringify(
    JSON.parse(
      execFileSync(launch.file, [...launch.prefix, 'tree', String(pid)], { encoding: 'utf8' }),
    ).tree,
  );
  assert.doesNotMatch(read, /Export 7/, 'the helper read the items of a closed menu');
  assert.match(read, /"notShown":40/, 'the closed menu does not say how many items it left out');
  // An open menu shows its items.
  const file = (await query({ role: 'menu', name: 'File' }))[0];
  assert.ok(file?.ref, `the menu has no ref:\n${shown}`);
  await commands.answer(ReticleCommand.ACT, {
    ref: file.ref,
    action: ActionType.CLICK,
    args: { foreground: true, settleMs: 600 },
  });
  const open = (await commands.answer(ReticleCommand.SNAPSHOT, {})).tree;
  await commands.answer(ReticleCommand.ACT, {
    action: ActionType.PRESS,
    args: { text: 'Escape', foreground: true, settleMs: 400 },
  });
  assert.match(open, /Export 7/, `the open menu does not show its items:\n${open}`);
  const closed = (await commands.answer(ReticleCommand.SNAPSHOT, {})).tree;
  assert.doesNotMatch(closed, /Export 7/, `Escape did not close the menu:\n${closed}`);
  held += 1;
  held += await bigTable();
  // A button on a page that is not shown is in the tree, and has no place on the screen: a
  // click on it is refused, and the refusal says why. Thunderbird hides its menu bar this way,
  // and the realm gave its menus a place a person cannot click.
  const behind = (await query({ role: 'button', name: 'Behind' }))[0];
  assert.ok(behind?.ref, 'the button on the second page is not in the tree');
  assert.ok(
    !behind.states.includes('visible'),
    `a button not on the screen is visible: ${JSON.stringify(behind)}`,
  );
  await assert.rejects(
    commands.answer(ReticleCommand.ACT, {
      ref: behind.ref,
      action: ActionType.CLICK,
      args: { foreground: true },
    }),
    /not showing/,
  );
  held += 1;
  process.stdout.write(`computer atspicheck: ${String(held)} of 12 cases held\n`);
} finally {
  fixture.kill();
}

// A sheet of LibreOffice Calc gives a child for each cell. The helper read every child of a long
// table to keep the ones on the screen, and a read of Calc took more than two minutes.
async function bigTable() {
  const app = spawn('python3', [fileURLToPath(new URL('bigtable.py', import.meta.url))], {
    stdio: 'inherit',
  });
  try {
    let table;
    for (let i = 0; i < 60 && table === undefined; i += 1) {
      await sleep(500);
      const listed = JSON.parse(
        execFileSync(launch.file, [...launch.prefix, 'apps'], { encoding: 'utf8' }),
      ).apps;
      table = listed.find((one) => 'bigtable.py' === one.name)?.pid;
    }
    assert.ok(table, 'the big table did not join the accessibility bus');
    // The bridge waits 8 seconds for a command; a read that takes longer is no read.
    const read = JSON.stringify(
      JSON.parse(
        execFileSync(launch.file, [...launch.prefix, 'tree', String(table)], {
          encoding: 'utf8',
          timeout: 8000,
        }),
      ).tree,
    );
    assert.match(read, /r0c0/, 'the cells on the screen were not read');
    assert.doesNotMatch(read, /r150000c0/, 'a cell far below the screen was read');
    assert.match(read, /"notShown":[0-9]{6}/, 'the table does not say how many cells it left out');
    const peer = new PeerCommands({
      driver: new MacDriver({
        helper: launch.file,
        app: 'bigtable.py',
        pid: table,
        run: servingHelper(launch.prefix),
      }),
      emit: () => undefined,
    });
    await peer.answer(ReticleCommand.SNAPSHOT, {});
    const cell = (await peer.answer(ReticleCommand.QUERY, { name: 'r3c1' })).elements[0];
    assert.ok(cell?.ref, 'the cell r3c1 has no ref');
    const clicked = await peer.answer(ReticleCommand.ACT, {
      ref: cell.ref,
      action: ActionType.CLICK,
      args: { foreground: true, settleMs: 400 },
    });
    assert.ok(clicked.ok !== false, `the click on a cell failed: ${JSON.stringify(clicked)}`);
    return 1;
  } finally {
    app.kill();
  }
}
