// Multi-agent THROUGHPUT comparison: Reticle vs Playwright, N concurrent "agents" racing to
// detect a fixed workload (all BUGS, buggy variant only). This measures WALL-CLOCK to finish the
// whole workload at concurrency C, not correctness — the scorecard axis lives in run.mjs.
//
// Reticle model: ONE `reticle mcp` daemon on 4460, ONE McpStdioClient, C headless-Chrome tabs =
//   C concurrent SDK sessions sharing that one daemon. Shard BUGS across the C tabs, drive them
//   with Promise.all. Session pinning: the bench-app SDK always dials 4460, so every tab lands on
//   the same origin and reticle_sessions can't tell them apart by base URL. We disambiguate by
//   giving each worker a per-worker query param (?w=<i>) and matching the EXACT session url after
//   every navigation (each worker's url is unique = bug id + w, so it resolves to one tab).
// Playwright model: ONE chromium, C isolated contexts, each drives its shard serially, all
//   concurrent. Playwright has no daemon — parallelism is bounded by browser process memory.
//
// The check logic below is replicated (buggy-variant only) from reticle-harness.mjs /
// playwright-harness.mjs — those aren't imported because they run both variants and own a daemon.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { McpStdioClient } from '../harness/mcp-client.mjs';
import { BUGS, APP_ORIGIN, bugUrl } from './bugs.mjs';
import { ensureApp } from './run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'packages', 'core', 'dist', 'cli.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.BENCH_RETICLE_PORT ?? '4460';
const MAX_BROWSERS = Number(process.env.MAX_BROWSERS ?? 8); // hard cap on concurrent chrome/contexts

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseText = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const stopDaemon = () => {
  try {
    execSync(`node ${JSON.stringify(CLI)} stop --port ${PORT} --quiet`, { stdio: 'ignore' });
  } catch {}
};

// round-robin shard so each worker gets a balanced slice
const shard = (arr, c) => {
  const out = Array.from({ length: c }, () => []);
  arr.forEach((x, i) => out[i % c].push(x));
  return out;
};

// --- args ---
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const LIMIT = Number(flag('limit', BUGS.length));
const LEVELS = flag('levels', flag('concurrency', '1,3'))
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);
const WORKLOAD = BUGS.slice(0, LIMIT);

// ============================ RETICLE ============================
async function reticleLevel(C, bugs) {
  stopDaemon();
  const client = new McpStdioClient('node', [CLI, 'mcp', '--port', PORT], {
    RETICLE_PORT: PORT,
    RETICLE_TOOL_PROFILE: 'full',
  });
  await client.start();
  const call = async (name, args) => parseText((await client.callTool(name, args)).text ?? '');

  // spawn C headless Chromes, each on a distinct landing url ?w=<i> = one session per worker
  const chromes = [];
  for (let i = 0; i < C; i++) {
    const profile = path.join(os.tmpdir(), `rmab-${process.pid}-${C}-${i}`);
    const landing = `${APP_ORIGIN}/?w=${i}`;
    const p = spawn(
      CHROME,
      ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, landing],
      { stdio: 'ignore', detached: true },
    );
    p.unref();
    chromes.push(p);
  }

  // resolve each worker's landing session id by exact url
  const sids = new Array(C).fill(undefined);
  for (let attempt = 0; attempt < 60 && sids.includes(undefined); attempt++) {
    const s = await call('reticle_sessions', {});
    for (let i = 0; i < C; i++) {
      if (sids[i]) continue;
      const f = (s?.sessions ?? []).find((x) => x.url === `${APP_ORIGIN}/?w=${i}`);
      if (f) sids[i] = f.sessionId;
    }
    if (sids.includes(undefined)) await sleep(500);
  }

  const worker = async (i, myBugs) => {
    const state = { sid: sids[i] };
    const refOf = async (t) =>
      (await call('reticle_query', { sessionId: state.sid, by: 'testid', value: t }))?.elements?.[0]
        ?.ref;
    const waitRef = async (t, timeoutMs = 6000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await refOf(t);
        if (r) return r;
        if (Date.now() >= deadline) return undefined;
        await sleep(150);
      }
    };
    const goto = async (url) => {
      await call('reticle_navigate', { sessionId: state.sid, url });
      for (let k = 0; k < 40; k++) {
        const s = await call('reticle_sessions', {});
        const f = (s?.sessions ?? []).find((x) => x.url === url && !x.throttled);
        if (f) {
          state.sid = f.sessionId;
          break;
        }
        await sleep(250);
      }
      await sleep(400);
    };
    const doPrep = async (prep) => {
      if (!prep?.fill) return;
      const ref = await waitRef(prep.fill);
      if (ref) {
        await call('reticle_act', {
          sessionId: state.sid,
          ref,
          action: 'fill',
          args: { value: prep.text },
        });
        await sleep(200);
      }
    };
    const clickSteps = async (steps) => {
      for (const t of steps) {
        const ref = await waitRef(t);
        if (ref) await call('reticle_act', { sessionId: state.sid, ref, action: 'click' });
        await sleep(250);
      }
    };

    let caught = 0;
    for (const bug of myBugs) {
      const url = `${bugUrl(bug.id)}&w=${i}`; // bugUrl always has ?reticle-bug=, so append &w
      try {
        await goto(url);
        await clickSteps(bug.setup);
        if (await runReticleCheck(call, state, waitRef, doPrep, bug)) caught++;
      } catch {
        /* a worker error shouldn't sink the whole level */
      }
    }
    return caught;
  };

  const t0 = Date.now();
  const counts = await Promise.all(shard(bugs, C).map((s, i) => worker(i, s)));
  const ms = Date.now() - t0;

  try {
    await client.stop();
  } catch {}
  for (const c of chromes) {
    try {
      process.kill(-c.pid);
    } catch {}
  }
  stopDaemon();
  return { ms, caught: counts.reduce((a, b) => a + b, 0), peak: C };
}

// buggy-variant check runner, replicated from reticle-harness.mjs
async function runReticleCheck(call, state, waitRef, doPrep, bug) {
  const sid = () => state.sid;
  const c = bug.check;
  if (c.kind === 'usable') {
    const ref = await waitRef(c.testid);
    if (!ref) return false;
    const ins = await call('reticle_inspect', { sessionId: sid(), ref });
    const b = ins?.box;
    const st = ins?.styles ?? {};
    return (
      ins.occluded === true ||
      (b && (b.width === 0 || b.height === 0)) ||
      st.opacity === '0' ||
      ins.visible === false
    );
  }
  if (c.kind === 'paint') return false; // no pixel diff from the reticle script
  if (c.kind === 'domCountMatchesState') {
    const stv = await call('reticle_state', { sessionId: sid(), store: 'app', path: c.statePath });
    const v = stv?.value;
    const truth = Array.isArray(v) ? v.length : Number((JSON.stringify(v).match(/\d+/) ?? [])[0]);
    const snap = await call('reticle_snapshot', {
      sessionId: sid(),
      scope: `[data-testid="${c.testid}"]`,
    });
    const domNum = Number((String(snap?.tree ?? '').match(/\d+/g) ?? [])[0]);
    return Number.isFinite(truth) && Number.isFinite(domNum) && truth !== domNum;
  }
  if (c.kind === 'consoleCleanAfter') {
    await doPrep(c.prep);
    const ref = await waitRef(c.steps[0]);
    if (!ref) return false;
    const act0 = await call('reticle_act', { sessionId: sid(), ref, action: 'click' });
    await sleep(400);
    const con = await call('reticle_console', {
      sessionId: sid(),
      level: 'error',
      since: act0?.since,
    });
    return (con?.logs ?? []).length > 0;
  }
  if (c.kind === 'netCountAfter') {
    await doPrep(c.prep);
    const ref = await waitRef(c.steps[0]);
    if (!ref) return false;
    await call('reticle_act', { sessionId: sid(), ref, action: 'click' });
    await sleep(600);
    const net = await call('reticle_network', { sessionId: sid(), method: c.method, limit: 50 });
    const n = (net?.calls ?? []).filter((e) => String(e.url ?? '').includes(c.urlContains)).length;
    return n !== c.expected;
  }
  if (c.kind === 'stateInvariantAfter') {
    const pre = await call('reticle_state', { sessionId: sid(), store: 'app', path: c.statePath });
    await doPrep(c.prep);
    const ref = await waitRef(c.steps[0]);
    if (!ref) return false;
    await call('reticle_act', { sessionId: sid(), ref, action: 'click' });
    await sleep(400);
    const post = await call('reticle_state', { sessionId: sid(), store: 'app', path: c.statePath });
    return JSON.stringify(pre?.value) !== JSON.stringify(post?.value);
  }
  if (c.kind === 'domText') {
    const snap = await call('reticle_snapshot', {
      sessionId: sid(),
      scope: `[data-testid="${c.testid}"]`,
    });
    const txt = String(snap?.tree ?? '')
      .replace(/\(ref=[^)]*\)/g, '')
      .replace(/[-•"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return !!txt && !txt.includes(String(c.expected));
  }
  if (c.kind === 'stateEqualsAfter') {
    await doPrep(c.prep);
    const ref = await waitRef(c.steps[0]);
    if (!ref) return false;
    await call('reticle_act', { sessionId: sid(), ref, action: 'click' });
    await sleep(400);
    const post = await call('reticle_state', { sessionId: sid(), store: 'app', path: c.statePath });
    return JSON.stringify(post?.value) !== JSON.stringify(c.expected);
  }
  return false;
}

// ============================ PLAYWRIGHT ============================
async function playwrightLevel(C, bugs) {
  const browser = await chromium.launch();
  const peak = { cur: 0, max: 0 };
  const sel = (t) => `[data-testid="${t}"]`;

  const worker = async (myBugs) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    peak.cur += 1;
    peak.max = Math.max(peak.max, peak.cur);
    const consoleErrors = [];
    const requests = [];
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
    const fillPrep = async (prep) => {
      if (prep?.fill) {
        await page.fill(sel(prep.fill), prep.text).catch(() => {});
        await sleep(200);
      }
    };

    let caught = 0;
    for (const bug of myBugs) {
      try {
        await page.goto(bugUrl(bug.id), { waitUntil: 'domcontentloaded', timeout: 8000 });
        await sleep(600);
        for (const t of bug.setup) {
          await waitFor(t);
          await click(t);
          await sleep(400);
        }
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
                  return { opacity: s.opacity, occluded: top !== el && !el.contains(top) };
                })
                .catch(() => null)
            : null;
          if (
            ok &&
            (!box ||
              box.width === 0 ||
              box.height === 0 ||
              (info && (info.opacity === '0' || info.occluded)))
          )
            caught++;
        } else if (c.kind === 'paint') {
          await sleep(400);
          await page.screenshot({ fullPage: false }); // pay the pixel cost; no baseline in a buggy-only run
        } else if (c.kind === 'consoleCleanAfter') {
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          consoleErrors.length = 0;
          if (ok) await click(c.steps[0]);
          await sleep(500);
          if (ok && consoleErrors.length > 0) caught++;
        } else if (c.kind === 'netCountAfter') {
          await fillPrep(c.prep);
          const ok = await waitFor(c.steps[0]);
          requests.length = 0;
          if (ok) await click(c.steps[0]);
          await sleep(700);
          const n = requests.filter(
            (r) => r.method === c.method && r.url.includes(c.urlContains),
          ).length;
          if (ok && n !== c.expected) caught++;
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
          if (ok && txt && !txt.includes(String(c.expected))) caught++;
        }
        // domCountMatchesState / stateInvariantAfter / stateEqualsAfter: Playwright can't read app state -> never caught
      } catch {
        /* keep the worker alive */
      }
    }
    peak.cur -= 1;
    await ctx.close().catch(() => {});
    return caught;
  };

  const t0 = Date.now();
  const counts = await Promise.all(shard(bugs, C).map((s) => worker(s)));
  const ms = Date.now() - t0;
  await browser.close();
  return { ms, caught: counts.reduce((a, b) => a + b, 0), peak: peak.max };
}

// ============================ DRIVER ============================
(async () => {
  const procs = await ensureApp();
  await sleep(1000);

  const levels = LEVELS.map((c) => Math.min(c, MAX_BROWSERS));
  levels.forEach((c, i) => {
    if (c !== LEVELS[i])
      console.log(
        `CAP: concurrency ${LEVELS[i]} exceeds MAX_BROWSERS=${MAX_BROWSERS}, capped to ${c}`,
      );
  });

  const out = { workload: WORKLOAD.length, levels, reticle: {}, playwright: {} };

  for (const C of levels) {
    console.log(`\n[reticle] C=${C} — ${WORKLOAD.length} bugs across ${C} sessions…`);
    const r = await reticleLevel(C, WORKLOAD);
    out.reticle[C] = r;
    console.log(
      `[reticle] C=${C}: ${r.ms}ms, caught=${r.caught}/${WORKLOAD.length}, peakTabs=${r.peak}`,
    );

    console.log(`[playwright] C=${C} — ${WORKLOAD.length} bugs across ${C} contexts…`);
    const p = await playwrightLevel(C, WORKLOAD);
    out.playwright[C] = p;
    console.log(
      `[playwright] C=${C}: ${p.ms}ms, caught=${p.caught}/${WORKLOAD.length}, peakContexts=${p.peak}`,
    );
  }

  // derive throughput + speedup
  const base = levels[0];
  const derive = (tool) => {
    for (const C of levels) {
      const e = out[tool][C];
      e.bugsPerSec = +(WORKLOAD.length / (e.ms / 1000)).toFixed(3);
      e.speedup = +(out[tool][base].ms / e.ms).toFixed(2);
    }
  };
  derive('reticle');
  derive('playwright');

  writeFileSync(path.join(__dirname, 'results-multiagent.json'), JSON.stringify(out, null, 2));

  // table
  const top = levels[levels.length - 1];
  const fmt = (tool) => {
    const cells = levels.map((C) => `${out[tool][C].ms}ms`).join(' | ');
    return `| ${tool} | ${cells} | ${out[tool][top].speedup}x | ${out[tool][top].bugsPerSec} |`;
  };
  console.log('\n=== Multi-agent throughput ===');
  console.log(
    `| Tool | ${levels.map((C) => `C=${C} total`).join(' | ')} | C=${top} speedup | bugs/sec @ C=${top} |`,
  );
  console.log(`|---|${levels.map(() => '--:').join('|')}|--:|--:|`);
  console.log(fmt('reticle'));
  console.log(fmt('playwright'));

  const ratio = out.playwright[top].ms / out.reticle[top].ms;
  console.log(
    `\nHEADLINE: Reticle is ${ratio.toFixed(1)}x ${ratio >= 1 ? 'faster than' : 'slower than'} Playwright at C=${top}.`,
  );
  if (out.reticle[top].caught === 0 || out.playwright[top].caught === 0) {
    console.log(
      'WARNING: a tool caught 0 bugs — workers may not be reaching the app; timing is suspect.',
    );
  }

  for (const p of procs) {
    try {
      process.kill(-p.pid);
    } catch {}
  }
  process.exit(0);
})().catch((e) => {
  console.error('MULTI-AGENT RUN ERROR', e);
  stopDaemon();
  process.exit(1);
});
