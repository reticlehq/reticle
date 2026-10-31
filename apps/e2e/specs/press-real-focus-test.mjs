// A document `press` moves focus, through the REAL keyboard.
//
// #1176: `press { text: "Tab" }` with no ref is a document key, and it was dispatched as a synthetic
// `KeyboardEvent` even when real input was configured. A synthetic key event does not move focus, so
// the tool reported `dispatched: true` over a page where nothing had moved, and there was no mode in
// which an agent could check keyboard focus order at all.
//
// The unit tests for this drive a FAKE `Page`: they record that `keyboard.press('Tab')` was CALLED
// rather than executing it, so they prove the routing and say nothing about focus. This spec is the
// other half, and it is the half the issue is actually about — a real Chromium, a real keyboard, and
// `document.activeElement` read before and after.
//
// The second half pins the aimed key: the same key WITH a ref focuses that element first and then
// presses the real key, so focus ends past the named control, not on the control that held focus
// before. (It used to stay synthetic, and a synthetic Enter submitted no form.)
//
// Needs the next-smoke app on :3100 — it has a known tab order (ping-button, add-task, edit-field).
import net from 'node:net';
import { chromium } from 'playwright';
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  CdpRealInputProvider,
} from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';

const SID = 'next-smoke';
const APP = process.env.PRESS_FOCUS_URL ?? 'http://localhost:3100/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

/** An OS-assigned free port, so two runs cannot collide on the CDP endpoint. */
const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => {
        resolve(port);
      });
    });
  });

console.log('\n=== A document press moves focus, through the real keyboard ===');

const cdpPort = await freePort();
// The battery's bridge port, NOT the product's 4400 default. run-ci.sh starts next-smoke with
// RETICLE_PORT=14400, and the app dials THAT — so a server on 4400 waits forever for a session
// that can never arrive. Measured in CI: this spec failed with "session 'next-smoke' never
// connected" on both attempts, while the spec that ran right after it connected to the same app.
const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
// `--remote-debugging-port` so the SERVER's own CdpRealInputProvider can attach to this browser.
// Playwright drives the same browser over its own pipe; the two channels do not conflict.
const browser = await chromium.launch({
  headless: true,
  args: [`--remote-debugging-port=${String(cdpPort)}`],
});
const page = await browser.newPage();
await page.goto(APP);
await waitForSession(() => server.bridge.sessions.list(), SID);

// `waitForSession` above exits the process on its own failure — the harness convention, and an exit
// does not run a `finally`. Everything AFTER it can still throw: a ref that never resolves, an
// `evaluate` against a page that navigated away. A leaked Chromium is what makes the NEXT spec fail
// for a reason that is not its own, and the runner collects daemons, not browsers.
try {
  const provider = new CdpRealInputProvider({ cdpUrl: `http://127.0.0.1:${String(cdpPort)}` });
  const deps = {
    sessions: server.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    realInput: provider,
  };
  const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: SID, ...a });
  const refOf = async (by, value) => {
    for (let i = 0; i < 30; i += 1) {
      const found = (await T('reticle_query', { by, value })).elements[0]?.ref;
      if (found) return found;
      await sleep(100);
    }
    throw new Error(`not found ${by}=${value}`);
  };

  /** Which control holds focus, named the way a reader would name it. */
  const activeControl = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (null === el || el === document.body) return '(body)';
      return el.getAttribute('data-testid') ?? el.tagName.toLowerCase();
    });

  chk(
    'the server can see the page this spec launched',
    await provider.isAvailableFor(page.url()),
    page.url(),
  );

  // Park focus on a known control that is NOT the first in tab order, so a Tab that does nothing
  // cannot be mistaken for a move.
  await page.evaluate(() => {
    document.querySelector('[data-testid="add-task"]')?.focus();
  });
  const beforeReal = await activeControl();
  chk('focus starts on a known control', 'add-task' === beforeReal, beforeReal);

  const real = await T('reticle_act', { action: 'press', args: { text: 'Tab' } });
  chk(
    'a document press runs through the real keyboard',
    'real' === real.inputMode,
    `inputMode=${String(real.inputMode)}`,
  );
  chk(
    '  and carries no inputModeReason, because it was not a fallback',
    undefined === real.inputModeReason,
    String(real.inputModeReason),
  );

  const afterReal = await activeControl();
  chk('the real keyboard MOVED focus', afterReal !== beforeReal, `${beforeReal} -> ${afterReal}`);
  chk('  to the next control in tab order', 'edit-field' === afterReal, afterReal);

  // A key WITH a ref is aimed at that element: Reticle focuses it, confirms it holds focus, then
  // presses the real key, as a person clicks into a field before typing. It used to stay synthetic
  // ("a real keyboard cannot aim at an element"), and a synthetic key gets no default action, so a
  // recorded Enter in a text field submitted nothing. Aimed at a control OTHER than the focused one,
  // a real Tab from that control proves both halves: it focused the target, then moved on from it.
  await page.evaluate(() => {
    document.querySelector('[data-testid="add-task"]')?.focus();
  });
  const beforeAimed = await activeControl();
  const aimed = await T('reticle_act', {
    ref: await refOf('testid', 'edit-field'),
    action: 'press',
    args: { text: 'Tab' },
  });
  chk(
    'a key WITH a ref also runs through the real keyboard',
    'real' === aimed.inputMode,
    `inputMode=${String(aimed.inputMode)}`,
  );
  chk(
    '  and carries no inputModeReason, because it was not a fallback',
    undefined === aimed.inputModeReason,
    String(aimed.inputModeReason),
  );
  const afterAimed = await activeControl();
  chk(
    '  and it focused the named control first, then the real Tab moved on from it',
    afterAimed !== beforeAimed && afterAimed !== 'edit-field',
    `${beforeAimed} -> (focus edit-field) -> ${afterAimed}`,
  );
} finally {
  await browser.close();
  await server.close();
}

console.log(
  `\n${0 === fail ? '✅ PRESS REAL FOCUS VERIFIED' : '❌ PRESS REAL FOCUS FAILED'} (${String(pass)} passed, ${String(fail)} failed)`,
);
process.exit(0 === fail ? 0 : 1);
