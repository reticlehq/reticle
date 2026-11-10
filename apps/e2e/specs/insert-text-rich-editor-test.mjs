// `insertText` against a REAL ProseMirror editor, read back from the editor's own document.
//
// The unit tests drive a mock DOM: they prove the events fire in the right order and say nothing
// about whether the library's model took the text. ProseMirror keeps its document in its own state,
// so the only honest proof is `view.state.doc` after the action — reading `textContent` would look
// exactly the same for a DOM write the model never saw, which is the false green this action exists
// to prevent.
//
// Needs next-smoke on :3100 (the route `/rich-text`, a fixture that is not linked from the app).
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
import { waitUntil } from '../wait-until.mjs';
import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';

const SID = 'next-smoke';
const APP = 'http://localhost:3100/rich-text';

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

/** The editor's own document, as only the editor can report it. */
const modelText = (page) =>
  page.evaluate(() => globalThis.proseMirrorText?.() ?? null);

console.log('\n=== insertText changes a real ProseMirror document ===');

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(APP);
await waitForSession(() => server.bridge.sessions.list(), SID);

try {
  const deps = {
    sessions: server.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
  };
  const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: SID, ...a });

  // The editor mounts after hydration and a dynamic import, so wait for the control itself rather
  // than for a number of milliseconds — a cold `next dev` compile is not a statement about the app.
  const ref = await waitUntil(async () => {
    const found = (await T('reticle_query', { by: 'testid', value: 'rich-text-editor' })).elements[0];
    return found?.ref;
  });
  chk('the ProseMirror editor is on the page', 'string' === typeof ref, String(ref));

  const before = await modelText(page);
  chk('the editor model starts empty', '' === before, JSON.stringify(before));

  const first = await T('reticle_act', { ref, action: 'insertText', args: { text: 'hello editor' } });
  chk(
    'the action reports the surface changed',
    true === first.result?.effect?.valueChanged,
    JSON.stringify(first.result?.effect ?? {}),
  );

  // The model updates through ProseMirror's own event handling, which may land a tick after the
  // action returns; wait for the CONSEQUENCE, then assert it.
  const afterFirst = await waitUntil(async () => {
    const text = await modelText(page);
    return 'hello editor' === text ? text : undefined;
  });
  chk(
    'the editor model holds the text, not only the DOM',
    'hello editor' === afterFirst,
    JSON.stringify(afterFirst),
  );

  // A second insert lands at the caret the first one left. ProseMirror would have replaced the whole
  // document in a model-desynchronised write, and a replace here would read as a pass on one insert.
  const second = await T('reticle_act', { ref, action: 'insertText', args: { text: ' again' } });
  chk(
    'the second action reports the surface changed too',
    true === second.result?.effect?.valueChanged,
    JSON.stringify(second.result?.effect ?? {}),
  );
  const afterSecond = await waitUntil(async () => {
    const text = await modelText(page);
    return 'hello editor again' === text ? text : undefined;
  });
  chk(
    'a second insert appends through the model, so the caret path is real',
    'hello editor again' === afterSecond,
    JSON.stringify(afterSecond),
  );

  const dom = await page.evaluate(
    () => document.querySelector('[data-testid="rich-text-editor"]')?.textContent ?? null,
  );
  chk('the rendered document agrees with the model', dom === afterSecond, JSON.stringify(dom));
} finally {
  await browser.close();
  await server.close();
}

console.log(
  `\n${0 === fail ? '✅ INSERT TEXT / PROSEMIRROR VERIFIED' : '❌ INSERT TEXT / PROSEMIRROR FAILED'} (${String(pass)} passed, ${String(fail)} failed)`,
);
process.exit(0 === fail ? 0 : 1);
