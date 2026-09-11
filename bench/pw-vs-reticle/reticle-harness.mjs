// Reticle-SCRIPT harness: a deterministic Node script that drives the Reticle MCP tools (no LLM)
// to verify each bug's intent. Measures observation cost (bytes of tool output consumed), latency,
// and whether the check correctly caught the bug. Mirrors what an agent would do, minus the model.
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpStdioClient, RETICLE_CLI as CLI } from '../harness/mcp-client.mjs';
import { APP_ORIGIN, bugUrl, storageBugUrl } from './bugs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.BENCH_RETICLE_PORT ?? '4460';
/**
 * DevTools port the harness's own Chrome listens on, so the daemon can drive the same tab.
 *
 * Per-process, NOT a constant. A fixed port is silently wrong when a previous run's Chrome is still
 * holding it: the new Chrome fails to bind, the daemon connects to the SURVIVOR, and every screenshot
 * comes from a browser sitting on a different page. That produced a visual diff of 0 changed pixels
 * for a page whose pixels demonstrably differ — a green verdict sourced from the wrong browser.
 */
const CDP_PORT = process.env.BENCH_CDP_PORT ?? String(9300 + (process.pid % 600));

/**
 * A marker this run stamps on every URL it loads, so its own sessions are identifiable.
 *
 * Filtering by "session I have not seen before" is not enough: a leftover browser's SDK reconnects on
 * a loop, so its sessions are perpetually new. Adopting one means every navigate/query/act goes to a
 * browser we do not control while screenshots go over CDP to the one we spawned — DOM checks keep
 * passing and pixel checks silently compare an untouched page. The app ignores unknown query params.
 */
const RUN_MARK = `__hbench=${String(process.pid)}`;
const marked = (url) => (url.includes('?') ? `${url}&${RUN_MARK}` : `${url}?${RUN_MARK}`);

const parseText = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
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

/**
 * Two URLs belong to the same benchmark run when they share an origin and a query string. The path is
 * deliberately ignored — the app rewrites it via history.pushState as soon as it routes.
 */
const sameRun = (a, b) => {
  try {
    const ua = new URL(a),
      ub = new URL(b);
    return ua.origin === ub.origin && ua.search === ub.search;
  } catch {
    return false;
  }
};

export async function runReticle(bugs) {
  // Drive mode, not attach.
  //
  // The harness used to spawn a plain headless Chrome and talk to it only through the in-page SDK.
  // That is a WEAKER configuration than the one it was being compared against: Playwright inherently
  // drives a browser, so the head-to-head was measuring driven-Playwright against attached-Reticle and
  // scoring the difference as a capability gap. Two of those "gaps" were the pixel checks below, which
  // Reticle can do — it just needs a driven page, because the always-on SDK ships no screenshotter.
  const client = new McpStdioClient('node', [CLI, 'mcp', '--port', PORT], {
    RETICLE_PORT: PORT,
    RETICLE_ADVERTISE_ALL_TOOLS: '1',
    RETICLE_CDP_URL: `http://127.0.0.1:${CDP_PORT}`,
  });
  await client.start();

  let bytes = 0;
  const call = async (name, args) => {
    const { text } = await client.callTool(name, args);
    bytes += (text ?? '').length;
    return parseText(text ?? '');
  };

  // one headless Chrome; we reticle_navigate it to each bug URL (fresh SDK session per load).
  const profile = path.join(os.tmpdir(), `rbench-${process.pid}`);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      marked(APP_ORIGIN),
    ],
    { stdio: 'ignore', detached: true },
  );
  chrome.unref();

  // Assert the daemon will drive OUR browser, not a survivor from an earlier run. Connecting to the
  // wrong Chrome is invisible at every later step — the tools all answer, they just answer about a
  // different page — so it has to be caught here or not at all.
  {
    const { chromium } = await import('playwright');
    let ok = false;
    for (let i = 0; i < 20 && !ok; i += 1) {
      try {
        const probe = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
        const urls = probe
          .contexts()
          .flatMap((c) => c.pages())
          .map((pg) => pg.url());
        ok = urls.some((u) => u.startsWith(APP_ORIGIN));
        await probe.close();
      } catch {
        // Chrome may not be listening yet.
      }
      if (!ok) await sleep(500);
    }
    if (!ok) {
      throw new Error(
        `CDP on :${CDP_PORT} is not showing ${APP_ORIGIN} — a stale Chrome is probably holding the ` +
          'port. Kill leftover browsers before running, or set BENCH_CDP_PORT to a free one.',
      );
    }
  }

  // Assert we are talking to OUR daemon, driving OUR browser.
  //
  // The MCP client spawns a daemon on a fixed port, but if one is ALREADY listening there the spawn
  // loses and every call is served by the survivor — which carries a different RETICLE_CDP_URL and
  // drives a different Chrome. Nothing downstream reveals it: sessions resolve, queries answer, and
  // screenshots succeed. They are just about another browser, which is how a visual diff came back
  // "0 changed pixels" for a page whose pixels demonstrably differ.
  //
  // A screenshot is the cheapest end-to-end proof that the daemon we reached owns the browser we
  // spawned, so it is taken up front and failure is loud.
  const proveOwnBrowser = async (probeSid) => {
    const probe = await call('reticle_screenshot', { sessionId: probeSid, name: 'harness-probe' });
    if (probe?.ok !== true) {
      throw new Error(
        `the daemon on :${PORT} could not screenshot (reason: ${probe?.reason ?? probe?.error ?? '?'}). ` +
          'That means it is NOT the daemon this harness spawned — a stale one is holding the port. ' +
          'Kill it before running: lsof -tiTCP:' +
          PORT +
          ' -sTCP:LISTEN | xargs kill',
      );
    }
  };

  // Wait for a session THIS run's browser created.
  //
  // This used to take sessions[0], i.e. whichever the daemon happened to list first. When any other
  // Chrome was connected — a leftover from an earlier run is the common case — the harness adopted
  // ITS session and every navigate/query/act went to that browser, while every screenshot went over
  // CDP to the one we spawned. DOM checks kept passing (they follow the session) and pixel checks
  // silently compared an untouched page, which is how a visual diff reported 0 changed pixels for a
  // page whose pixels demonstrably differed.
  let sid;
  for (let i = 0; i < 60 && !sid; i++) {
    const all = (await call('reticle_sessions', {}))?.sessions ?? [];
    sid = all.find((x) => x.url?.includes(RUN_MARK) && !x.stale)?.sessionId;
    if (!sid) await sleep(500);
  }
  if (!sid) {
    throw new Error(
      'no session appeared from the browser this harness spawned. Every connected session predates ' +
        'it, so driving one would report on a browser we do not control.',
    );
  }

  await proveOwnBrowser(sid);

  // navigate to a URL and return the fresh focused session id
  const goto = async (url) => {
    // Sessions from earlier bugs linger in the daemon's registry, and every CLEAN run of a category
    // navigates to the SAME url — so a URL match alone cannot tell this tab from a dead one, and
    // reading a dead tab's storage returns an empty, entirely plausible answer. Remember which
    // sessions existed BEFORE navigating and prefer one this navigation created.
    const before = new Set(
      ((await call('reticle_sessions', {}))?.sessions ?? []).map((x) => x.sessionId),
    );
    await call('reticle_navigate', { sessionId: sid, url: marked(url) });
    for (let i = 0; i < 30; i++) {
      const s = await call('reticle_sessions', {});
      const all = s?.sessions ?? [];
      // Match on URL and NEVER fall back to sessions[0].
      //
      // The old pick was `find(url matches && !throttled) ?? sessions[0]`. Every headless tab reports
      // hidden/unfocused, so it is always throttled — the first branch could never win, and every run
      // silently used sessions[0], which is whichever session the daemon happens to list first,
      // routinely a stale tab from an earlier bug. That is why checks read plausible-but-wrong values
      // (an inspect returning another element's geometry) instead of failing loudly: the queries all
      // succeeded, just against the wrong page. Prefer the freshest URL match; wait rather than guess.
      // Compare ORIGIN + QUERY, never the full href: the app pushes history on nav (/ -> /overview),
      // so an exact match goes empty the moment the app routes and the pick silently keeps a stale sid.
      // The query is what identifies the run (?reticle-bug=… / ?reticle-reset-storage=1); the path drifts.
      const matches = all.filter(
        (x) => !x.stale && x.url?.includes(RUN_MARK) && sameRun(x.url, marked(url)),
      );
      const fresh = matches.filter((x) => !before.has(x.sessionId));
      // Freshest first; among equals prefer an unthrottled tab; last match beats an arbitrary first.
      const pool = fresh.length > 0 ? fresh : matches;
      const focused = pool.find((x) => !x.throttled) ?? pool[pool.length - 1];
      if (focused) {
        sid = focused.sessionId;
        if (i > 1) break;
      }
      await sleep(300);
    }
    await sleep(400); // let the app render + SDK register capabilities
  };

  const refOf = async (testid) => {
    const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: testid });
    return q?.elements?.[0]?.ref;
  };
  // Post-login/nav renders are async; poll until the testid resolves (or timeout) before acting.
  const waitRef = async (testid, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ref = await refOf(testid);
      if (ref) return ref;
      if (Date.now() >= deadline) return undefined;
      await sleep(150);
    }
  };
  // Click a control by testid, RE-RESOLVING the ref if it went stale between query and act.
  //
  // A ref names a live element; if the subtree re-renders in the gap before the click, the ref is
  // gone and reticle_act errors "ref no longer resolves" — which is correct UX (re-query), and is
  // exactly what a competent agent does next. The shadow-refresh control re-renders on a poll, so a
  // single-shot resolve-then-act intermittently no-op'd. A no-op click makes zero requests — the same
  // signature as the dead-control bug under test — so the miss and the catch were indistinguishable.
  // Retry so the click actually lands and the test measures the control, not the race.
  const clickByTestid = async (testid) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await waitRef(testid);
      if (ref === undefined) return false;
      try {
        await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS });
        return true;
      } catch (e) {
        if (!String(e).includes('no longer resolves')) throw e;
        await sleep(150); // re-render settled; resolve a fresh ref and retry
      }
    }
    return false;
  };
  const doPrep = async (prep) => {
    if (!prep?.fill) return;
    const ref = await waitRef(prep.fill);
    if (ref) {
      await call('reticle_act', {
        sessionId: sid,
        ref,
        action: 'fill',
        args: { value: prep.text },
      });
      await sleep(200);
    }
  };
  // Benchmark controls carry real labels ("New deploy", "Deploy"); the browser's destructive-action
  // guard blocks those synthetic clicks unless the caller confirms. The harness is a deterministic
  // script driving a fixture, so it always confirms — otherwise the modal never opens.
  const CLICK_ARGS = { confirmDangerous: true };
  // Returns the testids it could NOT find. A silently skipped step is the worst failure mode here: the
  // check still runs, reads a perfectly plausible value from a page that never reached the right state,
  // and reports a confident wrong answer. Callers surface misses in the note.
  // Cursor of the most recent act. reticle_observe defaults to a narrow window ("since your last
  // act"), so a check that waits seconds before observing sees almost nothing: the stream checks saw
  // ONE event and concluded no frames had arrived while the page had rendered all five. Checks that
  // observe after a delay must pass `since`.
  let lastSince;
  const clickSteps = async (steps) => {
    const missed = [];
    for (const step of steps) {
      // A setup step is either a testid to click, or {fill,text} to type into. The fill form was
      // never handled here: it fell through to waitRef(object), missed, and was skipped. Compose's
      // generate() early-returns on an empty prompt, so the request under test never fired and the
      // check read "no matching call" as the bug — a false positive on five net bugs.
      const isFill = typeof step === 'object' && step !== null && typeof step.fill === 'string';
      const testid = isFill ? step.fill : step;
      const ref = await waitRef(testid);
      if (!ref) {
        missed.push(testid);
        await sleep(250);
        continue;
      }
      const res = await call('reticle_act', {
        sessionId: sid,
        ref,
        action: isFill ? 'fill' : 'click',
        args: isFill ? { value: step.text ?? '' } : CLICK_ARGS,
      });
      lastSince = res?.since ?? lastSince;
      await sleep(250);
    }
    return missed;
  };

  const results = [];
  for (const bug of bugs) {
    for (const variant of ['clean', 'buggy']) {
      const makeUrl = bug.category === 'storage' ? storageBugUrl : bugUrl;
      const url = variant === 'buggy' ? (bug.url ?? makeUrl(bug.id)) : makeUrl('');
      const before = bytes;
      const t0 = Date.now();
      let caught = false,
        note = '',
        setupNote = '';
      try {
        await goto(url);
        const setupMissed = await clickSteps(bug.setup);
        if (setupMissed.length > 0) setupNote = ` [setup missed: ${setupMissed.join(',')}]`;
        const c = bug.check;
        if (c.kind === 'usable') {
          const ref = await waitRef(c.testid);
          const ins = ref ? await call('reticle_inspect', { sessionId: sid, ref }) : null;
          const b = ins?.box;
          const st = ins?.styles ?? {};
          caught = !ref
            ? false
            : ins.occluded === true ||
              (b && (b.width === 0 || b.height === 0)) ||
              st.opacity === '0' ||
              ins.visible === false;
          note = ins
            ? `occluded=${ins.occluded} box=${b?.width}x${b?.height} opacity=${st.opacity}`
            : 'element not found';
        } else if (c.kind === 'paint') {
          // De-rigged. This branch used to hardcode caught=false with the note "reticle script has no
          // pixel diff" — the same shape of excuse that was found and removed on the PLAYWRIGHT side
          // earlier, left sitting on our own. reticle_screenshot + reticle_visual_diff exist; they
          // need a driven page, which this harness now has.
          //
          // Baseline on the clean variant, compare on the buggy one. A baseline capture is never a
          // detection, so clean always scores caught=false — capturing must not read as catching.
          const shotName = `paint-${bug.id}`;
          // The driven page and the SDK session are two views of the same tab that settle
          // independently: reticle_navigate returns when the SDK reports the new session, which can be
          // before the driven page has painted the new document. Screenshotting then captures the
          // PREVIOUS render, and comparing two such captures yields a confident 0.00% for pixels that
          // differ. Settle before either capture.
          await sleep(1200);
          if (variant === 'clean') {
            const shot = await call('reticle_screenshot', { sessionId: sid, name: shotName });
            caught = false;
            note =
              shot?.saved === true
                ? `baseline saved (${shotName})`
                : `baseline FAILED: ${shot?.reason ?? '?'}`;
          } else {
            // maxRatio tolerates the fixture's own volatility (a live clock digit is well under 1% of
            // pixels) while a global paint regression re-tints essentially everything.
            const diff = await call('reticle_visual_diff', {
              sessionId: sid,
              baseline: shotName,
              maxRatio: 0.01,
            });
            caught = diff?.ok === true && diff?.matched === false;
            const ratio = (diff?.ratio ?? 0) * 100;
            // A 0.00% result here is NOT evidence Reticle cannot see a paint regression. Driving the
            // same fixture with Playwright directly shows the bug plainly (html filter goes from
            // `none` to `hue-rotate(90deg) saturate(1.6)`, and the screenshots differ), so a zero
            // means this harness screenshotted a page that was not showing the bug — an unresolved
            // correlation problem between the SDK session and the driven page, not a capability gap.
            // Said here so the row cannot be read as "Reticle is blind to pixels".
            note =
              diff?.ok !== true
                ? `visual diff unavailable: ${diff?.reason ?? '?'}`
                : ratio === 0
                  ? 'changed 0.00% — UNTRUSTED: the driven page did not show the bug (harness correlation issue, not a capability gap)'
                  : `changed ${ratio.toFixed(2)}% of pixels (tolerance 1%)`;
          }
        } else if (c.kind === 'domCountMatchesState') {
          // truth: the real store array length (depth-0 markers cap the display, so read the array).
          const st = await call('reticle_state', {
            sessionId: sid,
            store: 'app',
            path: c.statePath,
            depth: 8,
          });
          const v = st?.value;
          const truth = Array.isArray(v)
            ? v.length
            : Number((JSON.stringify(v).match(/\d+/) ?? [])[0]);
          // display: read ONLY the snapshot tree text (not JSON metadata) for the badge number.
          const snap = await call('reticle_snapshot', {
            sessionId: sid,
            scope: `[data-testid="${c.testid}"]`,
          });
          const domNum = Number((String(snap?.tree ?? '').match(/\d+/g) ?? [])[0]);
          caught = Number.isFinite(truth) && Number.isFinite(domNum) && truth !== domNum;
          note = `storeLen=${truth} badge=${domNum}`;
        } else if (c.kind === 'consoleCleanAfter') {
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          await sleep(400);
          const con = await call('reticle_console', {
            sessionId: sid,
            level: 'error',
            since: act0?.since,
          });
          const errs = (con?.logs ?? []).length;
          caught = ref ? errs > 0 : false;
          note = ref ? `errors=${errs}` : 'compose-generate not reached';
        } else if (c.kind === 'netCountAfter') {
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          await sleep(600);
          // Scope to the act. Playwright's side resets its arrays before the click, so reading the
          // whole session here would have the two harnesses measuring different windows.
          const net = await call('reticle_network', {
            sessionId: sid,
            method: c.method,
            since: act0?.since,
            limit: 50,
          });
          const n = (net?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          ).length;
          caught = ref ? n !== c.expected : false;
          note = ref ? `count=${n} expected=${c.expected}` : 'compose-generate not reached';
        } else if (c.kind === 'netStatusAfter') {
          // net-status: hidden-500: the request FAILED (or answered the wrong media type) while the UI showed
          // success. Caught when no matching call carries the expected status (+ contentType if asked).
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          await sleep(RESPONSE_SETTLE_MS);
          // Act-scoped, matching the Playwright side's postBodies reset. Unscoped, a setup step hitting
          // the same URL would let reticle match the SETUP body and report "not caught" while
          // Playwright, correctly scoped, catches it.
          const net = await call('reticle_network', {
            sessionId: sid,
            since: act0?.since,
            limit: 50,
          });
          const matches = (net?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          );
          const good = matches.filter((e) => {
            if (Number(e.status) !== Number(c.expected)) return false;
            if (c.contentType === undefined) return true;
            return String(e.contentType ?? '').includes(c.contentType);
          });
          caught = ref ? good.length === 0 : false;
          note = ref
            ? `matched=${matches.length} ok=${good.length} statuses=${matches.map((m) => m.status).join('/') || 'none'}`
            : `${c.steps[0]} not reached`;
        } else if (c.kind === 'netBodyAfter') {
          // payload truth: the body actually sent/received must contain `expected`. `direction`
          // selects request vs response; bodies are opt-in capture, so an absent body is NOT a catch —
          // reporting "missing body" as a detection would be a false positive.
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          await sleep(RESPONSE_SETTLE_MS);
          // Act-scoped, matching the Playwright side's postBodies reset. Unscoped, a setup step hitting
          // the same URL would let reticle match the SETUP body and report "not caught" while
          // Playwright, correctly scoped, catches it.
          const net = await call('reticle_network', {
            sessionId: sid,
            since: act0?.since,
            limit: 50,
          });
          const matches = (net?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          );
          const field = c.direction === 'request' ? 'requestBody' : 'responseBody';
          const bodies = matches.map((m) => String(m[field] ?? ''));
          const anyBody = bodies.some((b) => b.length > 0);
          caught = ref && anyBody ? !bodies.some((b) => b.includes(c.expected)) : false;
          note = ref
            ? anyBody
              ? `${field} present, contains '${c.expected}'=${bodies.some((b) => b.includes(c.expected))}`
              : `${field} not captured (bodies are opt-in) — not counted as a detection`
            : `${c.steps[0]} not reached`;
        } else if (c.kind === 'netPendingAfter') {
          // in-flight oracle: caught when a matching request is STILL pending after withinMs. This
          // is the one a screenshot cannot reach — on `hung-but-ui-done` the DOM already says "done".
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          await sleep(c.withinMs ?? 3000);
          // Scope to the act, matching the Playwright side's reset. Reading the whole session meant
          // setup traffic to this URL counted as the bug's traffic on one side and not the other — the
          // two harnesses were measuring different windows on the same check.
          const net = await call('reticle_network', {
            sessionId: sid,
            since: act0?.since,
            limit: 50,
          });
          const matches = (net?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          );
          const stillPending = matches.filter((e) => e.pending === true || e.status === 'pending');
          const completed = matches.filter(
            (e) => Number(e.status) >= 200 && Number(e.status) < 400,
          );
          // Either still hanging, or it never landed a completed 2xx at all (aborted mid-flight).
          caught = ref ? stillPending.length > 0 || completed.length === 0 : false;
          note = ref
            ? `pending=${stillPending.length} completed2xx=${completed.length} of ${matches.length}`
            : `${c.steps[0]} not reached`;
        } else if (c.kind === 'domPresentVsBaseline') {
          // silent-removal: silent removal: a NON-INTERACTIVE element vanished. No click breaks, nothing errors —
          // only presence-vs-expected catches it.
          const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: c.testid });
          const found = (q?.elements ?? []).length;
          caught = found === 0;
          note = `testid ${c.testid} present=${found}`;
        } else if (c.kind === 'perfClsUnder') {
          // perf: layout shift: a screenshot taken after things settle looks perfect; the damage is in
          // WHEN the page moved. Read the CLS the SDK already reports.
          await sleep(1200); // let the late shift actually happen before judging
          const obs = await call('reticle_observe', {
            sessionId: sid,
            filters: ['perf'],
            since: 0,
          });
          // Read the PERF events. This used to read `obs.summary.layoutShift`, a field
          // reticle_observe does not return — that shape belongs to act_and_wait's causal summary —
          // so it was always undefined and the check always scored cls=0.000. It could never fire,
          // which made a genuine "we did not measure this" look like "the page was fine".
          //
          // CLS is cumulative and the SDK emits the running total, so the largest value IS the total.
          const cls = (obs?.events ?? [])
            .filter((e) => e.type === 'perf' && e.data?.metric === 'cls')
            .reduce((max, e) => Math.max(max, Number(e.data?.value ?? 0)), 0);
          caught = cls >= Number(c.expected);
          note = `cls=${cls.toFixed(4)} threshold=${c.expected}`;
        } else if (c.kind === 'perfNoLongTaskAfter') {
          // Long task: the main thread was blocked. Invisible to any DOM assertion.
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          await sleep(RESPONSE_SETTLE_MS);
          // Read the perf EVENTS, not summary.longTasks. The summary is a count, so it cannot honour
          // the declared threshold — the note printed `>${c.ms}ms` while the browser's fixed 50ms
          // longtask boundary was doing the deciding. `since` scopes this to the click, so an earlier
          // hydration task is not counted as a consequence of the action.
          const obs = await call('reticle_observe', {
            sessionId: sid,
            filters: ['perf'],
            since: act0?.since,
          });
          const durations = (obs?.events ?? [])
            .filter((e) => String(e?.data?.metric ?? '') === 'longtask')
            .map((e) => Number(e?.data?.value ?? 0));
          const overBudget = durations.filter((d) => d >= Number(c.ms));
          caught = ref ? overBudget.length > 0 : false;
          note = ref
            ? `longTasks>=${c.ms}ms: ${overBudget.length} (of ${durations.length} total)`
            : `${c.steps[0]} not reached`;
        } else if (c.kind === 'routeAfter') {
          // routing: routing: the VIEW renders correctly, so every DOM assertion passes — the URL is the
          // only thing that is wrong. Deep links and the back button are broken and nothing says so.
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          await sleep(400);
          const obs = await call('reticle_observe', {
            sessionId: sid,
            filters: ['route'],
            since: act0?.since,
          });
          const routes = (obs?.events ?? []).filter((e) => String(e.type ?? '') === 'route.change');
          if (!ref) {
            caught = false;
            note = `${c.steps[0]} not reached`;
          } else if (c.expectRoutes !== undefined) {
            // one click must produce exactly one history entry, or Back needs two presses
            caught = routes.length !== c.expectRoutes;
            note = `routeChanges=${routes.length} expected=${c.expectRoutes}`;
          } else {
            const last = routes.at(-1);
            const path = String(last?.data?.pathname ?? last?.data?.to ?? '');
            caught = !path.includes(c.expectPath);
            note = `path=${path || '(no route event)'} expected~${c.expectPath}`;
          }
        } else if (c.kind === 'signalFiredAfter') {
          // signal: signal: the network call succeeded, the DOM updated and the store is right — only the
          // app's own declared signal is missing, doubled, or typo'd. There is nothing in the rendered
          // page to compare against, which is why this category is reticle-only.
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref
            ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS })
            : {};
          // Generous, and deliberately NOT an early-exit poll: `signal-double-fire` is only visible if
          // the whole window is observed, so stopping at the first matching signal would score a
          // double fire as correct. Measured: the signal lands well after a 600ms wait.
          await sleep(2500);
          const obs = await call('reticle_observe', {
            sessionId: sid,
            filters: ['signal'],
            since: act0?.since,
          });
          // The 'signal' type bucket also carries page.health heartbeats, so match the event type
          // exactly rather than trusting the filter to mean only app signals.
          const fired = (obs?.events ?? []).filter(
            (e) => String(e?.type ?? '') === 'signal' && String(e?.data?.name ?? '') === c.signal,
          ).length;
          caught = ref ? fired !== c.expected : false;
          note = ref
            ? `${c.signal} fired=${fired} expected=${c.expected}`
            : `${c.steps[0]} not reached`;
        } else if (c.kind === 'storagePresentAfter') {
          // storage: persistence truth. The UI is right in every one of these — sign-in succeeds, sign-out
          // returns to the login screen. The lie only appears on the NEXT load, or to the server.
          // Asserted on `found` rather than the value because the tool redacts sensitive keys by design.
          await clickSteps(c.steps ?? []);
          // Sign-in POSTs before it persists; a 600ms window closed before the write landed and read
          // as "token never persisted" on a CLEAN build.
          await sleep(2500);
          const st = await call('reticle_storage', { sessionId: sid, area: c.area, key: c.key });
          const present = st?.found === true;
          // Prove the page is actually signed in when we read: an unauthenticated page has empty
          // storage for entirely legitimate reasons, and that reads identically to "the bug fired".
          const authed = (await refOf('sign-out')) !== undefined;
          caught = present !== c.expectPresent;
          note = `${c.area}[${c.key}] present=${present} expected=${c.expectPresent} authed=${authed}`;
        } else if (c.kind === 'domAbsentAfterDelay') {
          // timing: timing: the bug lives entirely in WHEN. Immediately after the action the page is
          // correct — the toast SHOULD be on screen. Only waiting past its own deadline reveals that
          // it never leaves.
          await doPrep(c.prep);
          const missed = await clickSteps(c.steps ?? []);
          await sleep(c.delayMs);
          const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: c.testid });
          const stillThere = (q?.elements ?? []).length > 0;
          caught = missed.length > 0 ? false : stillThere;
          note =
            missed.length > 0
              ? `steps missed: ${missed.join(',')}`
              : `${c.testid} present after ${c.delayMs}ms = ${stillThere}`;
        } else if (c.kind === 'settlesDespiteAnimation') {
          // false-positive trap: trap. Runs on the CLEAN build only and must produce NO detection. The page carries
          // infinite ambient animations; a settle oracle that treats "something is still moving" as
          // "not settled" would hang here and report a problem where there is none. Catching this is
          // the failure — it means the harness over-flags a healthy page.
          const t0 = Date.now();
          const w = await call('reticle_wait_for', {
            sessionId: sid,
            predicate: { kind: 'settled', quietMs: c.quietMs ?? 500 },
            timeout_ms: c.timeoutMs ?? 8000,
          });
          const settled = w?.pass === true || w?.ok === true;
          caught = !settled; // a trap is "caught" only when the harness wrongly flags a clean page
          note = `settled=${settled} in ${Date.now() - t0}ms (trap: caught must stay false)`;
        } else if (c.kind === 'domTextDeep') {
          // deep-dom: the content lives inside an open shadow root or a same-origin iframe. reticle_query
          // resolves testids through Testing Library, which does NOT cross a shadow boundary — the
          // snapshot walks shadowRoot and contentDocument, so read it there. Using query here would
          // report "not found" on a HEALTHY page and look exactly like a caught bug.
          const snap = await call('reticle_snapshot', { sessionId: sid, scope: c.scope });
          const tree = String(snap?.tree ?? '');
          caught = !tree.includes(c.expectText);
          note = `expected "${c.expectText}" in ${c.scope}: ${tree.includes(c.expectText)}`;
        } else if (c.kind === 'staleCacheAfterMutation') {
          // Assert FRESHNESS, not the value.
          //
          // The obvious oracle — "the total should go up" — is wrong here and taught the lesson the
          // hard way by firing on the clean build. `POST /api/items` answers **202 Accepted**: the add
          // is deliberately eventually-consistent, so the count legitimately has not moved yet even
          // when everything worked. Asserting on the value made a correct app look broken.
          //
          // `dataUpdatedAt` is the honest signal, and it is the one thing only the cache knows. After a
          // successful mutation the query that owns that data must have been REFRESHED; the timestamp
          // advancing proves a refetch landed. Frozen means nothing ever went back to the server, which
          // is the bug — and it is invisible in the DOM (the rendered number is identical either way)
          // and only indirectly visible on the wire.
          const readCache = async () => {
            const st = await call('reticle_state', { sessionId: sid, store: c.store, path: c.key });
            return { at: st?.value?.dataUpdatedAt, total: st?.value?.data?.total };
          };
          const before = await readCache();
          const clicked = await clickByTestid(c.testid);
          // Bounded wait, never a fixed sleep: only the ABSENCE of a refresh is the fault, never its
          // lateness. A fixed 2.5s window previously scored a slow-but-correct refetch as the bug.
          let after = before;
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            await sleep(400);
            after = await readCache();
            if (after.at !== before.at) break; // refreshed → healthy, stop early
          }
          // The precondition must be PROVEN before the consequence is judged: "no refetch" is only a
          // fault if the mutation actually succeeded. Otherwise a mis-click or an auth failure reads
          // as the stale-cache bug.
          const net = await call('reticle_network', { sessionId: sid, limit: 50 });
          const mutated = (net?.calls ?? []).some(
            (e) =>
              String(e.method ?? '').toUpperCase() === 'POST' &&
              String(e.url ?? '').includes('/api/items') &&
              Number(e.status) >= 200 &&
              Number(e.status) < 300,
          );
          caught = Boolean(clicked) && mutated && before.at !== undefined && after.at === before.at;
          note = !clicked
            ? `${c.testid} not clickable`
            : `mutated=${String(mutated)} dataUpdatedAt ${before.at === after.at ? 'FROZEN' : 'advanced'} (total ${after.total})`;
        } else if (c.kind === 'chartGeometryFault') {
          // The chart fault rides the element descriptor, so this is ONE query — no extra tool, no
          // flag, and a healthy chart returns the same descriptor minus the field. That is the whole
          // design claim, so the check exercises it exactly as an agent would stumble into it.
          const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: c.testid });
          const faults = q?.elements?.[0]?.chart ?? [];
          caught = faults.length > 0;
          note = caught
            ? `chart faults: ${faults.map((f) => f.kind).join(',')}`
            : `no chart faults on ${c.testid}`;
        } else if (c.kind === 'deepNetCountAfter') {
          // deep-dom: a control INSIDE an open shadow root whose handler is gone. It looks and reads
          // identically; only the request it should have made is missing.
          //
          // An earlier version of this check passed `selector:` to reticle_act. That input does not
          // exist — act takes a `ref` from query/snapshot — so the call was a no-op and BOTH variants
          // showed zero requests. I read that as "reticle_act cannot reach into a shadow root" and
          // recorded a product gap that was not real. Query genuinely could not see shadow content at
          // the time, which made the wrong explanation fit. Both are fixed; this now resolves a ref
          // the normal way and clicks it.
          const before = await call('reticle_network', { sessionId: sid, limit: 50 });
          const beforeN = (before?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          ).length;
          const clicked = await clickByTestid(c.deepTestid);
          await sleep(900);
          const after = await call('reticle_network', { sessionId: sid, limit: 50 });
          const afterN = (after?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          ).length;
          // Only a click that actually LANDED can prove the control is dead. If the ref never resolved
          // we cannot tell a dead control from an unreachable one, so we do not claim a catch.
          caught = clicked ? afterN - beforeN < 1 : false;
          note = clicked
            ? `${c.urlContains} calls +${afterN - beforeN}`
            : `${c.deepTestid} not resolvable (shadow-root query returned no ref)`;
        } else if (c.kind === 'deepCountMatchesState') {
          // deep-dom: truth is the store's array length; display is a number rendered INSIDE a same-origin
          // iframe. Comparing static frame text would prove nothing — a frozen count still renders the
          // same label. Only store-vs-frame catches a panel stuck on a value that was once true.
          const st = await call('reticle_state', {
            sessionId: sid,
            store: 'app',
            path: c.statePath,
            depth: 8,
          });
          const v = st?.value;
          const truth = Array.isArray(v)
            ? v.length
            : Number((JSON.stringify(v).match(/\d+/) ?? [])[0]);
          const snap = await call('reticle_snapshot', { sessionId: sid, scope: c.scope });
          const shown = Number((String(snap?.tree ?? '').match(/\d+/g) ?? [])[0]);
          caught = Number.isFinite(truth) && Number.isFinite(shown) && truth !== shown;
          note = `store=${truth} frame=${shown}`;
        } else if (c.kind === 'streamFramesAfter') {
          // streams: the connection is open and healthy and the DOM is rendered; the app is simply never
          // told anything. No single moment reveals it — only the frame timeline.
          await sleep(c.waitMs ?? 2500);
          const obs = await call('reticle_observe', {
            sessionId: sid,
            filters: ['net'],
            since: lastSince,
          });
          const frames = (obs?.events ?? []).filter(
            (e) =>
              String(e?.type ?? '') === 'net.stream' &&
              String(e?.data?.direction ?? '') === 'in' &&
              String(e?.data?.url ?? '').includes(c.urlContains),
          );
          caught = frames.length < (c.minFrames ?? 1);
          note = `${c.urlContains} inbound frames=${frames.length} (need >=${c.minFrames ?? 1})`;
        } else if (c.kind === 'streamVsDomCount') {
          // The sharpest shape in this suite: the stream DELIVERED n frames, the UI rendered m steps.
          // A frame the client silently drops (unparseable JSON) leaves no error and no visual gap —
          // the log is just quietly short. Only the wire against the DOM shows it.
          await sleep(c.waitMs ?? 2500);
          const obs = await call('reticle_observe', {
            sessionId: sid,
            filters: ['net'],
            since: lastSince,
          });
          const frames = (obs?.events ?? []).filter(
            (e) =>
              String(e?.type ?? '') === 'net.stream' &&
              String(e?.data?.direction ?? '') === 'in' &&
              String(e?.data?.url ?? '').includes(c.urlContains),
          ).length;
          // Read the steps from reticle_query, NOT the snapshot: they live in a plain <div>, and the
          // snapshot tree omits generic non-semantic containers (it returns ""), while query returns
          // the element with its text. A snapshot read scored rendered=0 on a HEALTHY page — a false
          // positive indistinguishable from the bug.
          const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: c.testid });
          const rendered = String(q?.elements?.[0]?.text ?? '')
            .split('·')
            .map((s) => s.trim())
            .filter((s) => s.length > 0).length;
          caught = frames > 0 && rendered < frames;
          note = `frames=${frames} rendered=${rendered}`;
        } else if (c.kind === 'streamPayloadAfter') {
          const ref = await waitRef(c.steps[0]);
          let since = lastSince;
          if (ref) {
            const res = await call('reticle_act', {
              sessionId: sid,
              ref,
              action: 'click',
              args: CLICK_ARGS,
            });
            since = res?.since ?? since;
          }
          await sleep(c.waitMs ?? 1200);
          const obs = await call('reticle_observe', {
            sessionId: sid,
            filters: ['net'],
            since,
          });
          const hit = (obs?.events ?? []).some(
            (e) =>
              String(e?.type ?? '') === 'net.stream' &&
              String(e?.data?.direction ?? '') === 'in' &&
              JSON.stringify(e?.data ?? {}).includes(c.expectContains),
          );
          caught = ref ? !hit : false;
          note = ref
            ? `frame containing "${c.expectContains}": ${hit}`
            : `${c.steps[0]} not reached`;
        } else if (c.kind === 'netCountAfterBurst') {
          // timing: debounce: each fill is one input event, so a burst of fills is a burst of keystrokes.
          // A debounced client collapses them into ONE request; an undebounced one fires per event.
          // Results are identical either way — only the count differs.
          const ref = await waitRef(c.testid);
          let since;
          if (ref) {
            for (const value of c.values) {
              const res = await call('reticle_act', {
                sessionId: sid,
                ref,
                action: 'fill',
                args: { value },
              });
              since ??= res?.since;
              await sleep(c.gapMs ?? 60); // inside the debounce window on a healthy build
            }
          }
          await sleep(c.settleMs ?? 1200);
          const net = await call('reticle_network', { sessionId: sid, limit: 100 });
          const n = (net?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          ).length;
          caught = ref ? n > c.maxExpected : false;
          note = ref
            ? `${c.urlContains} requests=${n} (max ${c.maxExpected} for ${c.values.length} keystrokes)`
            : `${c.testid} not reached`;
        } else if (c.kind === 'netCountCapped') {
          // timing: retry storm: the endpoint always fails, so correct and incorrect look identical at
          // any instant. The only difference is how many times we asked before giving up.
          const ref = await waitRef(c.steps[0]);
          if (ref)
            await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS });
          await sleep(c.settleMs ?? 3000);
          const net = await call('reticle_network', { sessionId: sid, limit: 100 });
          const n = (net?.calls ?? []).filter((e) =>
            String(e.url ?? '').includes(c.urlContains),
          ).length;
          caught = ref ? n > c.maxExpected : false;
          note = ref
            ? `${c.urlContains} attempts=${n} (max ${c.maxExpected})`
            : `${c.steps[0]} not reached`;
        } else if (c.kind === 'stableTextDespiteChurn') {
          // false-positive trap: trap, CLEAN-only by nature. A neighbouring region rewrites itself several times a
          // second on a healthy build. A text/diff oracle that reads "it changed" as "it broke" would
          // flag this forever. Detection here is the FAILURE — it means the harness over-flags.
          const first = await call('reticle_query', {
            sessionId: sid,
            by: 'testid',
            value: c.churnTestid,
          });
          await sleep(c.waitMs ?? 1200);
          const second = await call('reticle_query', {
            sessionId: sid,
            by: 'testid',
            value: c.churnTestid,
          });
          const churned =
            String(first?.elements?.[0]?.text ?? '') !== String(second?.elements?.[0]?.text ?? '');
          const stable = await call('reticle_query', {
            sessionId: sid,
            by: 'testid',
            value: c.stableTestid,
          });
          const stableText = String(stable?.elements?.[0]?.text ?? '');
          // The trap only means something if the region ACTUALLY churned; otherwise it passes vacuously.
          caught = churned && !stableText.includes(c.expectStable);
          note = `churned=${churned} stable="${stableText}" (trap: caught must stay false)`;
        } else if (c.kind === 'stateInvariantAfter') {
          const pre = await call('reticle_state', {
            sessionId: sid,
            store: 'app',
            path: c.statePath,
            depth: 8,
          });
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          if (ref)
            await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS });
          await sleep(400);
          const post = await call('reticle_state', {
            sessionId: sid,
            store: 'app',
            path: c.statePath,
            depth: 8,
          });
          caught = ref ? JSON.stringify(pre?.value) !== JSON.stringify(post?.value) : false;
          note = `before=${JSON.stringify(pre?.value)} after=${JSON.stringify(post?.value)}`;
        } else if (c.kind === 'domText') {
          // reticle_query returns the element's rendered text in a `.text` field — works for
          // decorative (role=generic) nodes the a11y snapshot tree omits. For a control whose visible
          // text IS its accessible name (a button label), `.text` is omitted as redundant, so fall
          // back to `.name` — the same string the label carries.
          const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: c.testid });
          const el0 = q?.elements?.[0];
          const txt = String(el0?.text ?? el0?.name ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          caught = !txt ? false : !txt.includes(String(c.expected));
          note = `text="${txt.slice(0, 40)}" expected~="${c.expected}"`;
        } else if (c.kind === 'stateEqualsAfter') {
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          if (ref)
            await call('reticle_act', { sessionId: sid, ref, action: 'click', args: CLICK_ARGS });
          await sleep(400);
          const post = await call('reticle_state', {
            sessionId: sid,
            store: 'app',
            path: c.statePath,
            depth: 8,
          });
          caught = ref ? JSON.stringify(post?.value) !== JSON.stringify(c.expected) : false;
          note = `after=${JSON.stringify(post?.value)} expected=${JSON.stringify(c.expected)}`;
        }
      } catch (e) {
        note = `ERR ${e.message}`;
      }
      results.push({
        harness: 'reticle-script',
        bug: bug.id,
        category: bug.category,
        variant,
        caught,
        expect: bug.expect,
        bytes: bytes - before,
        ms: Date.now() - t0,
        note: note + setupNote,
      });
    }
  }

  try {
    await client.stop();
  } catch {}
  try {
    process.kill(-chrome.pid);
  } catch {}
  return results;
}
