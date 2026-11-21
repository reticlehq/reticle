// Checks the realm against two browsers that Reticle did not write, on a page of this folder:
// a feed that adds ten posts when it is scrolled near its end.
//   - the posts of the page are read as text;
//   - a scroll loads more posts: Safari by its scroll bar, Chrome by a key, with no pointer.
//
//   node native/mac/browsercheck.mjs
//
// Needs the Accessibility permission. Build the package first. The screen goes to each browser
// for the time of its check: macOS does not give the tree of a window on another Space.
// A browser that is open already is not used: its windows belong to the person. Chrome runs with
// a profile of this run, so it reads no account and no history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const helper = `${here}build/reticle-ax`;
const page = `${here}feed.html`;
const profile = mkdtempSync(join(tmpdir(), 'reticle-cu-chrome-'));
const BROWSERS = [
  { app: 'Safari', by: undefined, open: ['-a', 'Safari', page] },
  {
    app: 'Google Chrome',
    by: 'key',
    open: [
      '-na',
      'Google Chrome',
      '--args',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      `file://${page}`,
    ],
  },
];
const pidOf = (app) => {
  try {
    return Number(execFileSync('pgrep', ['-x', app], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};

let held = 0;
try {
  for (const browser of BROWSERS) {
    if (!existsSync(`/Applications/${browser.app}.app`) || 0 !== pidOf(browser.app)) {
      process.stdout.write(
        `computer-use browsercheck: skipped ${browser.app}, not there or open already\n`,
      );
      continue;
    }
    execFileSync('open', browser.open);
    let pid = 0;
    for (let tries = 0; tries < 40 && 0 === pid; tries += 1) {
      await sleep(250);
      pid = pidOf(browser.app);
    }
    assert.ok(0 !== pid, `${browser.app} did not start`);
    try {
      const driver = new MacDriver({ helper, app: browser.app, pid });
      const commands = new PeerCommands({
        driver,
        emit: () => undefined,
      });
      // The last post that is read. A query gives the elements a person can see, so the count
      // of posts says little: the number of the last one says how far the feed went.
      const posts = async () =>
        Math.max(
          0,
          ...(await commands.answer(ReticleCommand.QUERY, { role: 'text' })).elements
            .map((e) => /^Post (\d+)$/.exec(e.name)?.[1])
            .filter((n) => n !== undefined)
            .map(Number),
        );
      let switched = false;
      for (let tries = 0; tries < 100 && 0 === (await posts()); tries += 1) {
        // A Chromium browser gives its page only after the accessibility switch is set.
        if (10 === tries) {
          execFileSync(helper, ['web-tree', String(pid), 'on']);
          switched = true;
        }
        await sleep(250);
      }
      // A browser that just started does not give its page the keyboard at once, and a key that
      // is sent before that scrolls nothing. Wait until the page is the element with the keyboard.
      const pageHasKeyboard = async () => {
        const all = [(await driver.read()).root];
        for (const node of all) {
          all.push(...(node.children ?? []));
        }
        return all.some((n) => 'document' === n.role && n.states.includes('focused'));
      };
      for (let tries = 0; tries < 40 && !(await pageHasKeyboard()); tries += 1) {
        await sleep(250);
      }
      const before = await posts();
      if (0 === before) {
        const seenNow = await driver.read();
        const all = [seenNow.root];
        for (const node of all) {
          all.push(...(node.children ?? []));
        }
        const names = all.filter((n) => n.name.length > 0).map((n) => `${n.role}:${n.name}`);
        assert.fail(
          (seenNow.windowsNotOnScreen ?? 0) > 0
            ? `${browser.app}: its window is on another Space, and macOS does not give the tree of a window there. Run the check with the desktop in view, not from a full-screen Space.`
            : `${browser.app}: no post of the page was read. ${String(all.length)} elements: ${names.slice(0, 25).join(' | ')}`,
        );
      }
      const scrolled = await commands.answer(ReticleCommand.SCROLL, { fraction: 1 });
      assert.equal(scrolled.scrolled, true, `${browser.app}: the scroll reported no effect`);
      assert.equal(scrolled.by, browser.by, `${browser.app}: the scroll went another way`);
      let after = before;
      for (let tries = 0; tries < 20 && after <= before; tries += 1) {
        await sleep(250);
        after = await posts();
      }
      assert.ok(
        after > before,
        `${browser.app}: the posts on the screen are the same after the scroll`,
      );
      // The page writes the count of its posts in its title: the proof that the feed loaded more.
      const titles = (await commands.answer(ReticleCommand.QUERY, { role: 'document' })).elements;
      assert.ok(
        titles.some((e) => 'Feed 20' === e.name),
        `${browser.app}: the feed loaded no more posts: ${JSON.stringify(titles.map((e) => e.name))}`,
      );
      process.stdout.write(
        `computer-use browsercheck: ${browser.app} read to post ${String(before)}, then to post ${String(after)}${switched ? ' (switch set)' : ''}\n`,
      );
      held += 1;
    } finally {
      process.kill(pid);
      // A browser that is started again in the second after it ended does not show its page.
      await sleep(3000);
    }
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
process.stdout.write(`computer-use browsercheck: ${String(held)} browsers held\n`);
