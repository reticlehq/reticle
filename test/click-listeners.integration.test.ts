/**
 * The CDP click-handler reading, against a REAL browser and a real page.
 *
 * This is the test the reviewer asked for: no fake adapter and no hand-written reading. It drives
 * headless Chromium and asks `DOMDebugger.getEventListeners` the same question the guard asks. The
 * point is provenance: every other reading in the system can prove a handler PRESENT, and only this
 * one can prove one ABSENT, which is what a plain-navigation exemption needs.
 *
 * Each shape gets its OWN page. A `document` listener makes every element on that page handled, so
 * sharing one page between a "plain" link and a document-level listener would make the plain link
 * read as handled, which is correct behaviour and a misleading fixture.
 *
 * The reading is taken by REF, through the page's own registry, because the guard acts on the ref.
 * A reading keyed on a coordinate can land on an overlay or on a different node, so the overlay case
 * below is pinned: it reads `true` only because the node comes from its ref, not a hit-test.
 *
 * Heavy and Chromium-dependent, so it lives here (run via `pnpm test:integration`), not in the fast
 * per-package unit gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page as PlaywrightPage } from 'playwright';
import { clickListenersOnRef } from '@reticlehq/server';

/**
 * A miniature ref registry on the page, so the test drives the same
 * `globalThis.__reticleRefs.resolve(ref)` path the real SDK exposes.
 *
 * The real registry holds Element references, so it resolves an element inside a shadow root as
 * readily as one in the light DOM. The shim has to look in both places for the same reason.
 */
const REF_SHIM = `
  (() => {
    const find = () => {
      const host = document.getElementById('host');
      if (host && host.shadowRoot) {
        const inShadow = host.shadowRoot.getElementById('target');
        if (inShadow) return inShadow;
      }
      return document.getElementById('target');
    };
    globalThis.__reticleRefs = {
      resolve: (ref) => {
        const el = find();
        return ref === 'r1' && el && el.isConnected ? el : null;
      },
    };
  })();
`;

/** The page shell: the case's body and script, plus the ref registry. */
const pageFor = (body, script) => `<!doctype html>
<html><body style="margin:0">
  ${body}
  <script>${script}${REF_SHIM}</script>
</body></html>`;

const PLAIN_LINK =
  '<div id="wrap" style="padding:24px"><a id="target" href="/billing/payment" style="display:block;padding:16px">Orders &amp; invoices</a></div>';
const SHADOW_BODY = '<div id="host" style="padding:24px"></div>';
const shadowScript = (wire) => `
  const host = document.getElementById('host');
  const sr = host.attachShadow({ mode: 'open' });
  sr.innerHTML = '<a id="target" href="/billing/payment" style="display:block;padding:16px">Orders</a>';
  ${wire}
`;

/**
 * The shapes, and the reading each must produce. The first is the exemption: no listener anywhere, so
 * a handlerless reading is genuinely available. Everything else must read as handled, including the
 * cases a plain ancestor walk or a coordinate hit-test would get wrong.
 */
const CASES = [
  {
    name: 'no listener anywhere',
    body: PLAIN_LINK,
    script: '',
    expected: false,
    why: 'the handlerless reading, which is the only thing that may exempt a link',
  },
  {
    name: 'addEventListener on the element',
    body: PLAIN_LINK,
    script:
      "document.getElementById('target').addEventListener('click', function (e) { e.preventDefault(); });",
    expected: true,
    why: 'no framework prop and no DOM attribute exposes this listener',
  },
  {
    name: 'a listener on an ANCESTOR',
    body: PLAIN_LINK,
    script: "document.getElementById('wrap').addEventListener('pointerdown', function () {});",
    expected: true,
    why: 'it runs on a bubbling click, and getEventListeners does not walk ancestors by itself',
  },
  {
    name: 'a listener on document',
    body: PLAIN_LINK,
    script: "document.addEventListener('mouseup', function () {});",
    expected: true,
    why: 'delegation makes it the handler for every element on the page',
  },
  {
    name: 'a dblclick listener, which the DBLCLICK gate must respect',
    body: PLAIN_LINK,
    script:
      "document.getElementById('target').addEventListener('dblclick', function (e) { e.preventDefault(); });",
    expected: true,
    why: 'the guard gates DBLCLICK, so a double-click-wired link must not read handlerless',
  },
  {
    name: 'a link inside a SHADOW ROOT with the listener on the HOST',
    body: SHADOW_BODY,
    script: shadowScript("host.addEventListener('click', function (e) { e.preventDefault(); });"),
    expected: true,
    why: 'a click is composed and crosses the shadow boundary; parentElement alone never reaches the host',
  },
  {
    name: 'a link inside a SHADOW ROOT with the listener on document.body',
    body: SHADOW_BODY,
    script: shadowScript(
      "document.body.addEventListener('click', function (e) { e.preventDefault(); });",
    ),
    expected: true,
    why: 'the composed walk has to climb out of the shadow tree and keep going',
  },
  {
    name: 'a link inside a SHADOW ROOT with the listener on the ROOT itself',
    body: SHADOW_BODY,
    script: shadowScript("sr.addEventListener('click', function (e) { e.preventDefault(); });"),
    expected: true,
    why: 'a click from a descendant propagates through the shadow root; jumping to the host misses it',
  },
  {
    name: 'a link under a root container with a delegated click listener (React 17+ shape)',
    body: '<div id="root" style="padding:24px"><a id="target" href="/billing/payment" style="display:block;padding:16px">Orders</a></div>',
    script: "document.getElementById('root').addEventListener('click', function () {});",
    expected: true,
    why: 'React delegates click to the root container, which is an ancestor on the click path',
  },
  {
    name: 'a link whose centre is covered by an overlay',
    body: `${PLAIN_LINK}<div id="overlay" style="position:absolute;inset:0"></div>`,
    script:
      "document.getElementById('target').addEventListener('click', function (e) { e.preventDefault(); });",
    expected: true,
    why: 'read by ref, so a coordinate landing on the overlay cannot decide the control reading',
  },
];

let browser;
let server;
let origin;

beforeAll(async () => {
  // One server whose path selects the case, so each test navigates to its own page.
  server = http.createServer((req, res) => {
    const key = (req.url ?? '/').split('/')[1] ?? '';
    const found = CASES[Number(key)] ?? CASES[0];
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageFor(found.body, found.script));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${String(server.address().port)}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  // Retain and close the server too: an open listening socket keeps the test process alive and makes
  // shutdown depend on runner teardown.
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
});

/** The reading for the target link on a freshly loaded page for `index`. */
async function readingOnPage(index) {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/${String(index)}`, { waitUntil: 'domcontentloaded' });
    return await clickListenersOnRef(page, 'r1');
  } finally {
    await page.close();
  }
}

describe('CDP reads real click listeners a page cannot report for itself', () => {
  for (const [index, testCase] of CASES.entries()) {
    it(`reads ${testCase.expected ? 'handled' : 'handlerless'} for ${testCase.name}`, async () => {
      expect(
        await readingOnPage(index),
        `expected ${String(testCase.expected)} because ${testCase.why}`,
      ).toBe(testCase.expected);
    });
  }

  it('answers `undefined`, never `false`, when the ref does not resolve', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/0`, { waitUntil: 'domcontentloaded' });
      // A ref the page's registry does not know: nothing to read, so nothing may be claimed.
      expect(await clickListenersOnRef(page, 'nope')).toBe(undefined);
    } finally {
      await page.close();
    }
  });
});
