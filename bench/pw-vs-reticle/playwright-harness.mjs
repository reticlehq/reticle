// Playwright-SCRIPT harness: a deterministic Playwright script (no LLM) that verifies each bug's
// intent using only what a browser automation tool can see — the DOM, computed styles, hit-testing,
// console, network, and pixels. It has NO access to the app's store or React commit stream, so the
// state/blast-radius checks structurally cannot be made (that gap is the benchmark's point). Measures
// bytes pulled to decide (screenshots are a real, large cost), latency, and detection.
import { chromium } from 'playwright';
import { bugUrl } from './bugs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (t) => `[data-testid="${t}"]`;

export async function runPlaywright(bugs) {
  const browser = await chromium.launch();
  const results = [];
  let baseline = null; // clean full-viewport screenshot, captured before any buggy paint compare

  for (const bug of bugs) {
    for (const variant of ['clean', 'buggy']) {
      const url = variant === 'buggy' ? (bug.url ?? bugUrl(bug.id)) : bugUrl('');
      const t0 = Date.now();
      let bytes = 0,
        caught = false,
        note = '';
      const consoleErrors = [];
      const requests = [];
      // fresh context+page per run so a crash/close never cascades to later bugs.
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
      const click = async (t) => {
        try {
          await page.locator(sel(t)).click({ timeout: 4000, force: true });
        } catch {}
      };
      const waitFor = async (t, ms = 6000) => {
        try {
          await page.locator(sel(t)).first().waitFor({ state: 'attached', timeout: ms });
          return true;
        } catch {
          return false;
        }
      };
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await sleep(600); // let React hydrate + set the pre-filled login inputs before clicking submit
        const fillPrep = async (prep) => {
          if (prep?.fill) {
            await page.fill(sel(prep.fill), prep.text).catch(() => {});
            await sleep(200);
          }
        };
        for (const t of bug.setup) {
          await waitFor(t);
          await click(t);
          await sleep(400);
        }
        const seen = await page
          .evaluate(() =>
            [...document.querySelectorAll('[data-testid]')]
              .map((e) => e.getAttribute('data-testid'))
              .slice(0, 12),
          )
          .catch(() => []);
        const err = await page
          .locator('[data-testid="login-error"]')
          .innerText()
          .catch(() => '');
        const diag = ` [seen:${seen.join(',')}${err ? ' loginErr:' + err : ''}]`;
        const c = bug.check;
        if (c.kind === 'usable') {
          const ok = await waitFor(c.testid, 6000);
          const loc = page.locator(sel(c.testid)).first();
          const box = ok ? await loc.boundingBox().catch(() => null) : null;
          const info = ok
            ? await loc
                .evaluate((el) => {
                  const s = getComputedStyle(el);
                  const r = el.getBoundingClientRect();
                  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                  return {
                    opacity: s.opacity,
                    cursor: s.cursor,
                    occluded: top !== el && !el.contains(top),
                  };
                })
                .catch(() => null)
            : null;
          bytes += JSON.stringify({ box, info }).length;
          caught = !ok
            ? false
            : !box ||
              box.width === 0 ||
              box.height === 0 ||
              (info && (info.opacity === '0' || info.occluded));
          note = ok
            ? `box=${box?.width}x${box?.height} opacity=${info?.opacity} occluded=${info?.occluded}`
            : 'element not found';
        } else if (c.kind === 'paint') {
          await sleep(400);
          const shot = await page.screenshot({ fullPage: false });
          bytes += shot.length;
          if (variant === 'clean') {
            baseline = shot;
            caught = false;
            note = `baseline captured (${shot.length}B)`;
          } else {
            const ref = baseline ?? shot;
            const n = Math.min(ref.length, shot.length);
            let diff = Math.abs(ref.length - shot.length);
            for (let i = 0; i < n; i++) if (ref[i] !== shot[i]) diff++;
            const ratio = diff / Math.max(ref.length, shot.length, 1);
            caught = ratio > 0.15;
            note = `png-byte diff ratio=${ratio.toFixed(3)} (shot ${shot.length}B)`;
          }
        } else if (c.kind === 'domCountMatchesState') {
          const txt = await page
            .locator(`${sel(c.testid)} .nav-badge`)
            .innerText()
            .catch(() => '');
          bytes += txt.length;
          caught = false; // reads the badge, but has no store truth to compare -> cannot catch the lie
          note = `badge="${txt.trim()}" — no app-state access to compare against`;
        } else if (c.kind === 'consoleCleanAfter') {
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          consoleErrors.length = 0;
          if (ok) await click(c.steps[0]);
          await sleep(500);
          bytes += consoleErrors.join('').length;
          caught = ok ? consoleErrors.length > 0 : false;
          note = ok ? `errors=${consoleErrors.length}` : 'compose-generate not reached';
        } else if (c.kind === 'netCountAfter') {
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          requests.length = 0;
          if (ok) await click(c.steps[0]);
          await sleep(700);
          const n = requests.filter(
            (r) => r.method === c.method && r.url.includes(c.urlContains),
          ).length;
          bytes += JSON.stringify(requests).length;
          caught = ok ? n !== c.expected : false;
          note = ok ? `count=${n} expected=${c.expected}` : 'compose-generate not reached';
        } else if (c.kind === 'stateInvariantAfter') {
          const ok = await waitFor(c.steps[0]);
          if (ok) await click(c.steps[0]);
          await sleep(300);
          caught = false; // off-screen store mutation, no DOM signal exists for Playwright to read
          note = 'no app-state access — off-screen store mutation is invisible to the DOM';
        } else if (c.kind === 'domText') {
          const ok = await waitFor(c.testid);
          const txt = ok
            ? (
                await page
                  .locator(sel(c.testid))
                  .first()
                  .innerText()
                  .catch(() => '')
              )
                .replace(/\s+/g, ' ')
                .trim()
            : '';
          bytes += txt.length;
          caught = ok && txt ? !txt.includes(String(c.expected)) : false;
          note = ok ? `text="${txt.slice(0, 40)}" expected~="${c.expected}"` : 'element not found';
        } else if (c.kind === 'stateEqualsAfter') {
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          if (ok) await click(c.steps[0]);
          await sleep(400);
          caught = false; // the invariant lives in the store; Playwright has no access to assert it
          note = 'no app-state access — store invariant not assertable from the DOM';
        }
        if (!caught && (note.includes('not found') || note.includes('not reached'))) note += diag;
      } catch (e) {
        note = `ERR ${e.message}`;
      }
      await ctx.close().catch(() => {});
      results.push({
        harness: 'playwright-script',
        bug: bug.id,
        category: bug.category,
        variant,
        caught,
        expect: bug.expect,
        bytes,
        ms: Date.now() - t0,
        note,
      });
    }
  }

  await browser.close();
  return results;
}
