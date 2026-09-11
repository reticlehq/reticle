/**
 * Source-pointer coverage: when Reticle reports on an element, does it say which file to open?
 *
 * The head-to-head benchmark answers "did the tool notice the bug?". This one answers the question
 * that decides whether a human gets pulled in afterwards: once the tool has noticed, does the agent
 * know where to go, or does it have to search? The published repair literature is unusually clear on
 * which half matters — identifying the right FILE is worth tens of points of fix rate, far more than
 * any amount of extra description of the symptom.
 *
 * WHAT IS SCORED, per registry bug:
 *   present  — the descriptor Reticle returned carries a `source` at all
 *   correct  — that source names a file the bug's ground-truth anchors actually live in
 *
 * Ground truth comes from ./ground-truth.mjs, which derives testid -> file:line by scanning the
 * fixture's own source. Nothing here is hand-maintained, so the benchmark cannot quietly drift out of
 * agreement with the app it measures.
 *
 * HONEST LIMITS, stated here rather than in a footnote:
 *   - This measures the ELEMENT path (query/descriptor). Failures with no element to point at —
 *     a network call that never fired, a signal that never emitted — have no source to carry and are
 *     reported separately as `noAnchor` rather than counted as misses.
 *   - "correct" means the right FILE. Line numbers are recorded but not scored: the stamp marks the
 *     JSX host element, which is the line an agent wants, but a component that renders its subject
 *     from a map legitimately points at the map rather than the row.
 *   - It measures Reticle only. There is no competitor column because no browser-automation tool
 *     claims this capability — which is the point, but it also means there is no baseline to beat.
 *
 *   node bench/diagnosis/measure.mjs [--limit N]
 *   node bench/diagnosis/measure.mjs --nosource   # the control: same run, stamps stripped
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpStdioClient, RETICLE_CLI as CLI } from '../harness/mcp-client.mjs';
import { BUGS, APP_ORIGIN, bugUrl, severityOf } from '../pw-vs-reticle/bugs.mjs';
import { groundTruth } from './ground-truth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.BENCH_RETICLE_PORT ?? '4461';

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg === -1 ? BUGS.length : Number(process.argv[limitArg + 1]);

/**
 * `--nosource` runs the fixture with its build-time source stamps stripped at runtime.
 *
 * This is the CONTROL for the headline number. "83 of 85 reports carry a file:line" only means
 * something if the coverage is caused by the stamp rather than by something incidental in the
 * fixture — a hardcoded path, a lucky default, a harness that fabricates the field. Removing only the
 * stamp and re-running should take coverage to zero. If it does not, the metric is measuring
 * something other than what it claims.
 */
const NO_SOURCE = process.argv.includes('--nosource');
const withCondition = (url) =>
  NO_SOURCE ? `${url}${url.includes('?') ? '&' : '/?'}nosource=1` : url;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseText = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

/** Same-run identity: origin + query. The path drifts as soon as the app calls pushState. */
const sameRun = (a, b) => {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.search === ub.search;
  } catch {
    return false;
  }
};

/** The file a source string names, dropping the `:line` suffix. */
const fileOf = (source) => (typeof source === 'string' ? source.replace(/:\d+$/, '') : undefined);

/**
 * Ground-truth files are repo-relative (`apps/bench-app/src/...`); the stamp is relative to the app's
 * own root (`src/...`). Compare on the suffix so the benchmark is not testing path conventions.
 */
const sameFile = (reported, truth) =>
  reported !== undefined && (truth.endsWith(reported) || reported.endsWith(truth));

async function main() {
  const client = new McpStdioClient('node', [CLI, 'mcp', '--port', PORT], {
    RETICLE_PORT: PORT,
    RETICLE_ADVERTISE_ALL_TOOLS: '1',
  });
  await client.start();

  const profile = path.join(os.tmpdir(), `rdiag-${String(process.pid)}`);
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, APP_ORIGIN],
    { stdio: 'ignore', detached: true },
  );
  chrome.unref();

  const call = async (name, args) => parseText((await client.callTool(name, args)).text ?? '');

  let sid;
  for (let i = 0; i < 40 && sid === undefined; i += 1) {
    sid = (await call('reticle_sessions', {}))?.sessions?.[0]?.sessionId;
    if (sid === undefined) await sleep(500);
  }
  if (sid === undefined) throw new Error('no Reticle session — is apps/bench-app running?');

  // Prefer a session THIS navigation created. Matching on URL alone cannot tell a fresh tab from a
  // dead one left by an earlier bug, and a dead tab answers every query plausibly and wrongly.
  const goto = async (url) => {
    const before = new Set(
      ((await call('reticle_sessions', {}))?.sessions ?? []).map((x) => x.sessionId),
    );
    await call('reticle_navigate', { sessionId: sid, url });
    for (let i = 0; i < 30; i += 1) {
      const all = (await call('reticle_sessions', {}))?.sessions ?? [];
      const matches = all.filter((x) => !x.stale && sameRun(x.url, url));
      const fresh = matches.filter((x) => !before.has(x.sessionId));
      const pool = fresh.length > 0 ? fresh : matches;
      const picked = pool.find((x) => !x.throttled) ?? pool[pool.length - 1];
      if (picked !== undefined) {
        sid = picked.sessionId;
        if (i > 1) break;
      }
      await sleep(300);
    }
    await sleep(400);
  };

  const queryOne = async (testid) => {
    const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: testid });
    return q?.elements?.[0];
  };
  const waitFor = async (testid, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const el = await queryOne(testid);
      if (el !== undefined) return el;
      if (Date.now() >= deadline) return undefined;
      await sleep(150);
    }
  };

  const rows = [];
  for (const bug of BUGS.slice(0, LIMIT)) {
    const truth = groundTruth(bug);
    // Score against the anchor the agent would actually be handed: the element the assertion is
    // about when there is one, else the control that triggered the failure.
    const anchors = truth.sites.filter((s) => s.role === 'subject');
    const chosen = anchors.length > 0 ? anchors : truth.sites;
    if (chosen.length === 0) {
      rows.push({ bug: bug.id, severity: severityOf(bug), outcome: 'noAnchor' });
      continue;
    }
    const testid = chosen[0].testid;
    try {
      await goto(withCondition(bugUrl(bug.id)));
      // Read each control's source AS IT IS CLICKED, not afterwards.
      //
      // This mirrors what Reticle actually does: act captures the anchor and its source BEFORE
      // dispatching, precisely because a navigating or destructive action unmounts its own target.
      // Querying after the fact instead measured a thing the product does not do — 15 bugs scored
      // "element not found" purely because clicking `login-submit` navigates away from it.
      let observed;
      for (const step of bug.setup ?? []) {
        const el = await waitFor(step);
        if (el?.ref !== undefined) {
          if (el.source !== undefined) observed = { testid: step, source: el.source };
          await call('reticle_act', { sessionId: sid, ref: el.ref, action: 'click' });
          await sleep(250);
        }
      }
      // The subject is the better answer when it is still on the page; the last control we actually
      // touched is the honest fallback, and is what a real failure report would carry.
      const subject = await waitFor(testid, 2500);
      const el = subject ?? observed;
      if (el === undefined) {
        rows.push({ bug: bug.id, severity: severityOf(bug), testid, outcome: 'elementNotFound' });
        continue;
      }
      const reported = fileOf(el.source);
      // Score against the ground truth for the control we ACTUALLY read. Falling back to the trigger
      // but grading against the subject's file would mark a correct pointer wrong.
      const scoredTestid = subject !== undefined ? testid : (observed?.testid ?? testid);
      const sites = truth.sites.filter((s) => s.testid === scoredTestid);
      const truthFiles = [...new Set((sites.length > 0 ? sites : chosen).map((s) => s.file))];
      rows.push({
        bug: bug.id,
        severity: severityOf(bug),
        testid: scoredTestid,
        anchorRole: subject !== undefined ? 'subject' : 'trigger',
        outcome: el.source === undefined ? 'noSource' : 'source',
        reported: el.source ?? null,
        truthFiles,
        correct: truthFiles.some((f) => sameFile(reported, f)),
      });
    } catch (error) {
      rows.push({
        bug: bug.id,
        severity: severityOf(bug),
        testid,
        outcome: 'error',
        error: String(error).slice(0, 160),
      });
    }
  }

  const scored = rows.filter((r) => r.outcome === 'source' || r.outcome === 'noSource');
  const present = scored.filter((r) => r.outcome === 'source');
  const correct = present.filter((r) => r.correct);
  const summary = {
    bugsAttempted: rows.length,
    scorable: scored.length,
    sourcePresent: present.length,
    sourceCorrect: correct.length,
    coveragePct: scored.length === 0 ? null : Math.round((present.length / scored.length) * 100),
    accuracyPct: present.length === 0 ? null : Math.round((correct.length / present.length) * 100),
    excluded: {
      noAnchor: rows.filter((r) => r.outcome === 'noAnchor').length,
      elementNotFound: rows.filter((r) => r.outcome === 'elementNotFound').length,
      error: rows.filter((r) => r.outcome === 'error').length,
    },
  };

  mkdirSync(path.join(HERE, '..', 'raw'), { recursive: true });
  writeFileSync(
    path.join(HERE, '..', 'raw', NO_SOURCE ? 'diagnosis-nosource.json' : 'diagnosis.json'),
    JSON.stringify({ summary, rows }, null, 2),
  );

  console.log(
    `\n=== Source-pointer coverage (Reticle${NO_SOURCE ? ', STAMPS STRIPPED — control' : ''}) ===\n`,
  );
  console.log(
    `scorable bugs        ${String(summary.scorable)} / ${String(summary.bugsAttempted)}`,
  );
  console.log(
    `carries a source     ${String(summary.sourcePresent)}  (${String(summary.coveragePct)}%)`,
  );
  console.log(
    `names the right file ${String(summary.sourceCorrect)}  (${String(summary.accuracyPct)}% of those present)`,
  );
  console.log(
    `excluded             noAnchor=${String(summary.excluded.noAnchor)} ` +
      `notFound=${String(summary.excluded.elementNotFound)} error=${String(summary.excluded.error)}`,
  );
  const wrong = present.filter((r) => !r.correct);
  if (wrong.length > 0) {
    console.log('\nreported a source that does not match ground truth:');
    for (const r of wrong.slice(0, 15)) {
      console.log(
        `  ${r.bug}: got ${String(r.reported)}, expected one of ${r.truthFiles.join(', ')}`,
      );
    }
  }
  console.log(`\nwritten to bench/raw/${NO_SOURCE ? 'diagnosis-nosource.json' : 'diagnosis.json'}`);
  await client.stop?.();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
