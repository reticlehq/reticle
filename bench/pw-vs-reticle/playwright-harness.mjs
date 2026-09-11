// Playwright-SCRIPT harness: a deterministic Playwright script (no LLM) that verifies each bug's
// intent using only what a browser automation tool can see — the DOM, computed styles, hit-testing,
// console, network, and pixels. It has NO access to the app's store or React commit stream, so the
// state/blast-radius checks structurally cannot be made (that gap is the benchmark's point). Measures
// bytes pulled to decide (screenshots are a real, large cost), latency, and detection.
import { chromium } from 'playwright';
import { bugUrl, storageBugUrl } from './bugs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait for a RESPONSE before judging its status or body.
 *
 * apps/api delays /api/generate-script by LLM_DELAY_MS (1500ms default) to imitate a real model call.
 * The old 800ms window closed while the request was still in flight, so the check saw
 * `statuses=pending` and read "no successful call" as the bug — a false positive on every clean build.
 * Must comfortably exceed that delay; counting REQUESTS is unaffected (they fire immediately), which
 * is why only the status/body checks need it.
 */
const RESPONSE_SETTLE_MS = 3000;

const sel = (t) => `[data-testid="${t}"]`;

export async function runPlaywright(bugs) {
  const browser = await chromium.launch();
  const results = [];
  let baseline = null; // clean full-viewport screenshot, captured before any buggy paint compare

  for (const bug of bugs) {
    for (const variant of ['clean', 'buggy']) {
      const makeUrl = bug.category === 'storage' ? storageBugUrl : bugUrl;
      const url = variant === 'buggy' ? (bug.url ?? makeUrl(bug.id)) : makeUrl('');
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
      // Outgoing bodies — Playwright exposes these, so the payload checks are a fair fight.
      const postBodies = [];
      page.on('request', (r) => {
        const body = r.postData();
        if (body !== null && body !== undefined) postBodies.push({ url: r.url(), body });
      });
      // Sockets open during setup, so this must be attached before any navigation happens.
      const wsFrames = [];
      page.on('websocket', (ws) => ws.on('framereceived', (f) => wsFrames.push(String(f.payload))));
      // Response statuses: Playwright CAN see these, so the hidden-500 class is fairly 'both'.
      const responses = [];
      page.on('response', (r) =>
        responses.push({
          url: r.url(),
          status: r.status(),
          contentType: String(r.headers()['content-type'] ?? ''),
        }),
      );
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
        for (const step of bug.setup) {
          // Same two shapes as the reticle harness: a testid to click, or {fill,text} to type into.
          const isFill = typeof step === 'object' && step !== null && typeof step.fill === 'string';
          const testid = isFill ? step.fill : step;
          await waitFor(testid);
          if (isFill)
            await page
              .locator(sel(testid))
              .fill(step.text ?? '')
              .catch(() => {});
          else await click(testid);
          await sleep(400);
        }
        const seen = await page
          .evaluate(() =>
            [...document.querySelectorAll('[data-testid]')]
              .map((e) => e.getAttribute('data-testid'))
              .slice(0, 12),
          )
          .catch(() => []);
        // Built ONLY when a failure note actually needs it.
        //
        // This used to run eagerly on every bug: `.innerText()` against a `login-error` element that
        // exists only on a FAILED login blocks for Playwright's full 30 s default before the catch
        // fires. Every one of the 170 runs paid it, which inflated Playwright's measured wall-time to
        // ~32 s/bug — and our published "10x faster" lead with it. The honest gap is ~1.26x. It also
        // turned a full head-to-head into a ~90-minute job instead of ~15.
        //
        // The bounded timeout is belt-and-braces: even on the failure path where the element is
        // genuinely absent, a diagnostic must not cost more than the check it is explaining.
        const buildDiag = async () => {
          const err = await page
            .locator('[data-testid="login-error"]')
            .innerText({ timeout: 500 })
            .catch(() => '');
          return ` [seen:${seen.join(',')}${err ? ' loginErr:' + err : ''}]`;
        };
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
        } else if (c.kind === 'staleCacheAfterMutation') {
          // Playwright's honest route: request cardinality. It cannot read the query cache, but a
          // mutation that never triggers a refetch is visible as a POST with no follow-up GET.
          const seen = [];
          const onReq = (r) => {
            if (r.url().includes('/api/items')) seen.push(r.method().toUpperCase());
          };
          page.on('request', onReq);
          await click(c.testid);
          await sleep(2500);
          page.off('request', onReq);
          const posts = seen.filter((m) => m === 'POST').length;
          const gets = seen.filter((m) => m === 'GET').length;
          caught = posts >= 1 && gets === 0;
          note = `POST=${posts} refetchGET=${gets}`;
        } else if (c.kind === 'chartGeometryFault') {
          // Playwright's fair shot: SVG geometry is ordinary DOM, so it can read `points`/`d` and
          // scan for non-finite or empty coordinates itself. It just has to be TOLD to look here —
          // which is the honest difference, not a capability gap.
          const attrs = await page
            .locator(`${sel(c.testid)} path, ${sel(c.testid)} polyline, ${sel(c.testid)} polygon`)
            .evaluateAll((els) =>
              els.flatMap((e) =>
                [e.getAttribute('d'), e.getAttribute('points')].filter((v) => v !== null),
              ),
            )
            .catch(() => []);
          const bad = attrs.filter((v) => /NaN|Infinity/i.test(v) || v.trim().length === 0);
          caught = bad.length > 0;
          note = caught ? `bad geometry x${bad.length}` : `geometry ok (${attrs.length} shapes)`;
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
        } else if (c.kind === 'domPresentVsBaseline') {
          // Playwright CAN check presence — no charity, this one is fairly 'both'.
          const el = await page.$(`[data-testid="${c.testid}"]`);
          caught = el === null;
          note = `testid ${c.testid} present=${el === null ? 0 : 1}`;
        } else if (c.kind === 'perfClsUnder' || c.kind === 'perfNoLongTaskAfter') {
          // Install the observers BEFORE the action, then act, then read. Creating them after the
          // click (as this did, 600ms after) with buffered:false meant the long task had already
          // finished and was never seen — the check could not catch its own bug. Using buffered:true
          // instead is the opposite error: it replays the whole page timeline, so React's initial
          // render counts as "a long task after the action" and the CLEAN build trips.
          //
          // CLS stays buffered on purpose: cumulative layout shift is a page-lifetime metric and the
          // injected shift happens during load, before any click.
          // Wait for the target BEFORE arming the long-task probe. Arming first made Playwright's
          // window up to 6s wider than the reticle side's act-scoped one, so ordinary churn during
          // waitFor scored as "a long task after the action" on the CLEAN build.
          if (c.kind === 'perfNoLongTaskAfter' && c.steps?.[0] !== undefined)
            await waitFor(c.steps[0]);
          await page.evaluate(() => {
            const probe = { cls: 0, longTaskDurations: [] };
            window.__reticleBenchPerf = probe;
            try {
              new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                  if (!e.hadRecentInput) probe.cls += e.value; // recent-input shifts are excluded by definition
                }
              }).observe({ type: 'layout-shift', buffered: true });
              new PerformanceObserver((list) => {
                for (const e of list.getEntries()) probe.longTaskDurations.push(e.duration);
              }).observe({ type: 'longtask' });
            } catch {
              /* entry type unsupported in this browser */
            }
          });
          if (c.kind === 'perfNoLongTaskAfter' && c.steps?.[0] !== undefined)
            await click(c.steps[0]);
          await sleep(1500); // let a late shift land, and the blocking task finish
          const metrics = await page.evaluate(
            () => window.__reticleBenchPerf ?? { cls: 0, longTaskDurations: [] },
          );
          if (c.kind === 'perfClsUnder') {
            caught = metrics.cls >= Number(c.expected);
            note = `cls=${metrics.cls.toFixed(3)} threshold=${c.expected}`;
          } else {
            // Compare against the DECLARED threshold. It was printed in the note but never used, so a
            // 60ms hydration task was reported as a ">200ms main-thread block" — the browser's fixed
            // 50ms longtask boundary was doing the deciding while the note claimed otherwise.
            const overBudget = metrics.longTaskDurations.filter((d) => d >= Number(c.ms));
            caught = overBudget.length > 0;
            note = `longTasks>=${c.ms}ms: ${overBudget.length} (of ${metrics.longTaskDurations.length} total)`;
          }
        } else if (c.kind === 'routeAfter') {
          // Playwright reads location directly, so a WRONG-PATH route is genuinely catchable here.
          // A DOUBLE history push is not — that needs the route event stream, not the final URL.
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          if (ok) await page.click(`[data-testid="${c.steps[0]}"]`);
          await sleep(400);
          if (!ok) {
            caught = false;
            note = `${c.steps[0]} not reached`;
          } else if (c.expectRoutes !== undefined) {
            caught = false;
            note = 'final URL cannot reveal a duplicate history entry';
          } else {
            const path = page.url();
            caught = !path.includes(c.expectPath);
            note = `url=${path} expected~${c.expectPath}`;
          }
        } else if (c.kind === 'signalFiredAfter') {
          // Playwright has no access to the app's signal stream at all — not a gap in this script, a
          // structural one. Recorded honestly as uncatchable rather than quietly skipped.
          await fillPrep(c.prep);
          caught = false;
          note = 'no signal stream visible to a DOM/pixel tool';
        } else if (c.kind === 'storagePresentAfter') {
          // Playwright reads storage directly via evaluate, so this class is genuinely catchable here.
          for (const t of c.steps ?? []) {
            await click(t);
            await sleep(250);
          }
          await sleep(2500); // sign-in POSTs before it persists
          const present = await page.evaluate(
            ({ area, key }) => {
              if (area === 'local') return localStorage.getItem(key) !== null;
              if (area === 'session') return sessionStorage.getItem(key) !== null;
              return document.cookie
                .split('; ')
                .some((c) => c.startsWith(`${key}=`) && !c.endsWith('='));
            },
            { area: c.area, key: c.key },
          );
          caught = present !== c.expectPresent;
          note = `${c.area}[${c.key}] present=${present} expected=${c.expectPresent}`;
        } else if (c.kind === 'domAbsentAfterDelay') {
          // Playwright can wait and re-check presence, so timing-of-disappearance is a fair 'both'.
          await fillPrep(c.prep);
          for (const t of c.steps ?? []) {
            await click(t);
            await sleep(250);
          }
          await sleep(c.delayMs);
          const el = await page.$(`[data-testid="${c.testid}"]`);
          caught = el !== null;
          note = `${c.testid} present after ${c.delayMs}ms = ${el !== null}`;
        } else if (c.kind === 'settlesDespiteAnimation') {
          // No settle oracle in the deterministic script harness — it cannot over-flag what it never
          // evaluates, so the trap is vacuously passed here rather than scored as a win.
          caught = false;
          note = 'no settle oracle in the script harness — trap not exercised';
        } else if (c.kind === 'domTextDeep') {
          // Playwright pierces open shadow roots in its own locators and can address a frame
          // explicitly, so this is a fair 'both' — not a Reticle-only win.
          let text = '';
          if (c.frame === true) {
            const f = page.frames().find((fr) => fr.url().includes('panel.html'));
            text = f ? await f.evaluate(() => document.body.innerText) : '';
          } else {
            text = await page
              .locator(`[data-testid="${c.deepTestid}"]`)
              .first()
              .innerText()
              .catch(() => '');
          }
          caught = !text.includes(c.expectText);
          note = `expected "${c.expectText}": ${text.includes(c.expectText)}`;
        } else if (c.kind === 'deepNetCountAfter') {
          const before = requests.filter((r) => r.url.includes(c.urlContains)).length;
          await page
            .locator(`[data-testid="${c.deepTestid}"]`)
            .first()
            .click({ timeout: 4000 })
            .catch(() => {});
          await sleep(900);
          const after = requests.filter((r) => r.url.includes(c.urlContains)).length;
          caught = after - before < 1;
          note = `${c.urlContains} calls +${after - before}`;
        } else if (c.kind === 'deepCountMatchesState') {
          // Playwright can read the frame, but the STORE length is not reachable from the DOM — the
          // visible row count is a different number (it is filtered/capped). Recorded as a structural
          // gap rather than pretended.
          caught = false;
          note = 'no app-state access — cannot compare the frame against the store';
        } else if (c.kind === 'streamFramesAfter' || c.kind === 'streamVsDomCount') {
          // An SSE body is a streaming response; this script harness sees the request, never the
          // individual frames, so it cannot compare the wire against the DOM. Stated, not skipped.
          await sleep(c.waitMs ?? 2500);
          caught = false;
          note = 'no SSE frame visibility in the script harness';
        } else if (c.kind === 'streamPayloadAfter') {
          // Playwright DOES expose WebSocket frames via page.on('websocket'), so this one is a fair
          // 'both' — claiming it as reticle-only would be charity to ourselves.
          // wsFrames is attached at page creation: the app opens its socket when the view mounts,
          // during SETUP, so a listener registered here would miss every frame and report 0 on a
          // healthy build.
          const frames = wsFrames;
          for (const t of c.steps ?? []) {
            await click(t);
            await sleep(250);
          }
          await sleep(c.waitMs ?? 1200);
          const hit = frames.some((f) => f.includes(c.expectContains));
          caught = !hit;
          note = `frame containing "${c.expectContains}": ${hit} (${frames.length} frames)`;
        } else if (c.kind === 'netCountAfterBurst') {
          // Playwright sees requests, so request-count timing is a fair 'both'.
          for (const value of c.values) {
            await page
              .locator(sel(c.testid))
              .fill(value)
              .catch(() => {});
            await sleep(c.gapMs ?? 60);
          }
          await sleep(c.settleMs ?? 1200);
          const n = requests.filter((r) => r.url.includes(c.urlContains)).length;
          caught = n > c.maxExpected;
          note = `${c.urlContains} requests=${n} (max ${c.maxExpected})`;
        } else if (c.kind === 'netCountCapped') {
          for (const t of c.steps ?? []) {
            await click(t);
            await sleep(200);
          }
          await sleep(c.settleMs ?? 3000);
          const n = requests.filter((r) => r.url.includes(c.urlContains)).length;
          caught = n > c.maxExpected;
          note = `${c.urlContains} attempts=${n} (max ${c.maxExpected})`;
        } else if (c.kind === 'stableTextDespiteChurn') {
          const read = async (t) =>
            page
              .locator(sel(t))
              .first()
              .innerText()
              .catch(() => '');
          const first = await read(c.churnTestid);
          await sleep(c.waitMs ?? 1200);
          const second = await read(c.churnTestid);
          const stableText = await read(c.stableTestid);
          caught = first !== second && !stableText.includes(c.expectStable);
          note = `churned=${first !== second} stable="${stableText}"`;
        } else if (c.kind === 'netStatusAfter') {
          // Playwright sees response statuses, so this class is genuinely catchable here — no charity.
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          if (ok) await click(c.steps[0]);
          await sleep(RESPONSE_SETTLE_MS);
          const matches = responses.filter((r) => r.url.includes(c.urlContains));
          const good = matches.filter(
            (r) =>
              r.status === Number(c.expected) &&
              (c.contentType === undefined || r.contentType.includes(c.contentType)),
          );
          caught = ok ? good.length === 0 : false;
          note = ok ? `matched=${matches.length} ok=${good.length}` : `${c.steps[0]} not reached`;
        } else if (c.kind === 'netBodyAfter') {
          // Playwright exposes the outgoing body via request.postData(). This branch used to return
          // caught=false with "bodies not captured", manufacturing a reticle-only win out of a one-line
          // API call. Mirrors the reticle check exactly: same substring, same direction semantics.
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          // Reset BEFORE the action. Placed after it (as this was, briefly) the array is cleared once
          // the request has already been recorded, so `bodies` is always empty and Playwright can never
          // observe a body at all — silently restoring the reticle-only win the de-rig pass removed.
          // The comment said "before"; the code did it after.
          postBodies.length = 0;
          if (ok) await click(c.steps[0]);
          await sleep(RESPONSE_SETTLE_MS);
          // Honour c.direction: this branch reads only OUTGOING bodies, which is all request.postData()
          // exposes. Stated rather than scored when the check asks for a response body.
          const responseDirection = c.direction !== undefined && c.direction !== 'request';
          const bodies = responseDirection
            ? []
            : postBodies.filter((b) => b.url.includes(c.urlContains)).map((b) => b.body);
          if (!ok) {
            caught = false;
            note = `${c.steps[0]} not reached`;
          } else if (responseDirection) {
            // Playwright's request.postData() is outgoing-only; a response body would need a
            // response.body() read. Stated rather than scored either way.
            caught = false;
            note = `direction '${c.direction}' not captured — only outgoing bodies are read here`;
          } else if (bodies.length === 0) {
            // No body seen at all is NOT evidence of the bug — say so rather than scoring a catch.
            caught = false;
            note = `no request body captured for ${c.urlContains}`;
          } else {
            caught = !bodies.some((b) => b.includes(c.expected));
            note = `body contains '${c.expected}'=${!caught} (${bodies.length} sent)`;
          }
        } else if (c.kind === 'netPendingAfter') {
          // The SAME two-part oracle the reticle branch uses: still in flight, OR no completed 2xx ever
          // landed. The reticle side had that second disjunct and this branch did not, so a hang that
          // sends nothing scored a catch there and a miss here — an asymmetry inside the very check the
          // de-rigging pass existed to remove, and it was the sole basis for the last surviving
          // reticle-only label in this category. requests[] and responses[] are both in scope; "no
          // completed 2xx" is one expression. Withholding it manufactured the win.
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          // Same reset rationale: pending is requests-minus-responses, and setup traffic to this URL
          // would skew both sides.
          requests.length = 0;
          responses.length = 0;
          if (ok) await click(c.steps[0]);
          await sleep(c.withinMs ?? RESPONSE_SETTLE_MS);
          const asked = requests.filter((r) => r.url.includes(c.urlContains)).length;
          const answered = responses.filter((r) => r.url.includes(c.urlContains));
          const completed = answered.filter((r) => r.status >= 200 && r.status < 400);
          const pending = asked - answered.length;
          caught = ok ? pending > 0 || completed.length === 0 : false;
          note = ok
            ? `pending=${pending} completed2xx=${completed.length} of ${asked}`
            : `${c.steps[0]} not reached`;
        }
        if (!caught && (note.includes('not found') || note.includes('not reached'))) {
          note += await buildDiag();
        }
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
