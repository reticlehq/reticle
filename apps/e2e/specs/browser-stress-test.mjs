// Brute force against the OTHER channel: daemon ↔ browser.
//
// The MCP transport now survives its worst day. This is the same treatment for the socket underneath
// it — the one carrying every command to the page. The failure shapes are different and the bar is
// the same: an answer, always. A tool that hangs because a tab closed is a hung agent, and "the tab
// went away" is an ordinary thing for a human to do mid-session.
//
// Covered here: a tab closed mid-command, two tabs at once (does killing one strand the other),
// a backgrounded/hidden page, and a reload underneath a live ref.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { waitForSession } from '../wait-for-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Defaults are the BATTERY's: run-ci.sh boots bench-app on :4310 dialing the bridge on :4400.
// Overridable so this can be run standalone against a privately-booted app, which is how it was
// developed — a spec that only works inside its harness is one nobody debugs.
const PORT = process.env.BROWSER_STRESS_PORT ?? '4400';
const APP = process.env.BROWSER_STRESS_APP ?? 'http://localhost:4310/';
// The app must be dialing OUR bridge port; booting it with a different RETICLE_PORT registers no
// session and every check below reads as a product failure. That cost a full run to notice.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

/** Settled = answered at all. A refusal is an answer; a timeout is the failure this hunts. */
async function settled(promise) {
  try {
    const value = await promise;
    return { answered: true, how: 'ok', value };
  } catch (err) {
    const msg = String(err);
    return { answered: !/timeout after/.test(msg), how: msg.slice(0, 90) };
  }
}

console.log('\n=== BROWSER STRESS: the daemon ↔ page channel ===');
process.on('unhandledRejection', () => undefined);
process.chdir(ROOT);

const client = new McpStdioClient('node', ['packages/server/dist/cli.js', 'mcp', '--port', PORT], {
  RETICLE_PORT: PORT,
  RETICLE_TELEMETRY: '0',
});
await client.start();

const call = (name, args = {}, timeoutMs = 45_000) =>
  client.request('tools/call', { name, arguments: args }, timeoutMs);
const payload = (r) => {
  const text = (r?.content ?? []).map((c) => c.text ?? '').join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

const { chromium } = await import('playwright');
const browser = await chromium.launch();

async function openTab(url = APP) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return page;
}

async function listSessions() {
  const r = await settled(call('reticle_sessions', {}));
  if (!r.answered) return [];
  return payload(r.value).sessions ?? [];
}
/**
 * OUR tabs, and only ours. The bridge is shared: a fixture tab open in the developer's own browser
 * joins every daemon this battery starts (run.mjs warns about it), so counting all sessions counts
 * strangers — and, worse, leaves the tools with more than one session to choose from, which is what
 * "a new tab restores a driveable session" really failed on: the call was answered, with
 * "multiple sessions connected". Every call below therefore names the session it means.
 */
const onApp = (s) => String(s?.url ?? '').startsWith(APP);
const idOf = (s) => s?.sessionId ?? s?.id;
const ourIds = async () => (await listSessions()).filter(onApp).map(idOf);

try {
  // ── 1. Two tabs at once ─────────────────────────────────────────────────────────────────────
  const tabA = await openTab();
  const tabB = await openTab();
  const both = await waitForSession(listSessions, onApp, { count: 2, what: `two tabs on ${APP}` });
  chk('two tabs register as two distinct sessions', new Set(both.map(idOf)).size >= 2, `${both.length} sessions`);
  const opened = new Set(both.map(idOf));

  // ── 2. Close one tab — the other must still drive ────────────────────────────────────────────
  await tabA.close();
  await sleep(1500);
  const remaining = (await ourIds()).filter((id) => opened.has(id));
  let sid = remaining[0];
  const afterClose = await settled(call('reticle_snapshot', { mode: 'interactive', sessionId: sid }));
  chk('closing one tab does not strand the other', afterClose.answered, afterClose.how);
  chk(
    '  and the dead session is gone from the list',
    remaining.length < opened.size && 0 < remaining.length,
    `${remaining.length} of our ${opened.size} left`,
  );

  // ── 3. Close a tab WHILE a command is in flight ──────────────────────────────────────────────
  // The nastiest ordering on this channel: the page accepts the command and dies before replying.
  {
    const inFlight = settled(call('reticle_snapshot', { mode: 'full', sessionId: sid }, 45_000));
    await sleep(30);
    await tabB.close();
    const r = await inFlight;
    chk('a command in flight when the tab closes still settles', r.answered, r.how);
  }

  // ── 4. Everything gone: no session at all ────────────────────────────────────────────────────
  {
    // Addressed by the id of the tab that just died: the refusal must NAME it, not hang.
    const r = await settled(call('reticle_snapshot', { sessionId: sid }));
    chk('with every tab closed, the tool refuses instead of hanging', r.answered, r.how);
  }

  // ── 5. A fresh tab after the wipe — the channel recovers ─────────────────────────────────────
  const tabC = await openTab();
  const [fresh] = await waitForSession(listSessions, (s) => onApp(s) && !opened.has(idOf(s)), {
    what: `a fresh tab on ${APP}`,
  });
  sid = idOf(fresh);
  const back = await settled(call('reticle_snapshot', { mode: 'interactive', sessionId: sid }));
  chk('a new tab restores a driveable session', back.answered && !payload(back.value ?? {}).error, back.how);

  // ── 6. Hidden page: the throttling case, on the channel rather than in a WKWebView ───────────
  {
    // A second tab in the same context pushes the first to the background.
    const front = await openTab('about:blank');
    await sleep(1500);
    const r = await settled(call('reticle_snapshot', { mode: 'interactive', sessionId: sid }, 45_000));
    chk('a backgrounded page still answers, or says why', r.answered, r.how);
    await front.close();
  }

  // ── 7. Reload underneath a live ref ──────────────────────────────────────────────────────────
  // The ref is invalidated by the reload; the contract is a NAMED refusal, never a wrong element.
  {
    const snap = await settled(call('reticle_snapshot', { mode: 'interactive', sessionId: sid }));
    const tree = JSON.stringify(payload(snap.value ?? {}));
    const ref = /\(ref=([A-Za-z0-9_-]+)\)/.exec(tree)?.[1];
    if (ref === undefined) {
      chk('a stale ref after reload is refused, not silently mis-clicked', true, 'no ref to test with — skipped');
    } else {
      await tabC.reload({ waitUntil: 'domcontentloaded' });
      await sleep(2500);
      const acted = await settled(call('reticle_act', { ref, action: 'click', sessionId: sid }));
      const body = acted.answered ? JSON.stringify(payload(acted.value ?? {})) : acted.how;
      chk(
        'a stale ref after reload is refused, not silently mis-clicked',
        acted.answered && /stale|no longer|not found|refus/i.test(body),
        body.slice(0, 90),
      );
    }
  }
} finally {
  // Close the browser, and NOTHING else. This used to also SIGKILL whatever was listening on PORT,
  // which was harmless while the spec owned a private port and destructive once it defaulted to the
  // battery's shared one: it murdered the daemon the next spec was about to use. run.mjs already
  // frees the port between specs; a spec reaching for the shared daemon's throat is exactly the
  // cross-spec coupling the per-spec process-group kill exists to avoid.
  await browser.close();
  await client.stop();
}

console.log(`\n${0 === fail ? '✅' : '❌'} BROWSER STRESS (${pass} passed, ${fail} failed)`);
process.exit(0 === fail ? 0 : 1);
