// Layer A runner: observation-cost benchmark across all scenarios x all tools.
// For each scenario: (optionally) capture a clean baseline, inject the regression,
// run each tool's idiomatic recipe, measure every payload, grade detection by a
// fixed rule, revert. Any failed cell is recorded verdict="NOT MEASURED".
import { writeFileSync } from 'node:fs';
import { makeAdapter } from './adapters.mjs';
import { inject, revert, revertAll } from './inject.mjs';

const URL = 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOOLS = ['playwright', 'devtools', 'iris'];

// Each scenario: steps (run before observe), observe kind, grade mode + regex.
// mode 'present'  -> detected if rx matches evidence.
// mode 'absent'   -> detected if rx does NOT match evidence (expected thing is gone).
// mode 'baseline' -> capture clean evidence too; detected via countDelta or differs.
const SCENARIOS = [
  {
    id: 'hidden-api-500',
    regression: null,
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-500', nameRe: /500 Server Error/, label: '500' } },
      { wait: 600 },
    ],
    mode: 'present',
    rx: /\b500\b/,
    signal: 'network request with status 500',
  },

  {
    id: 'wrong-status-404',
    regression: null,
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-404', nameRe: /404 Not Found/, label: '404' } },
      { wait: 600 },
    ],
    mode: 'present',
    rx: /\b404\b/,
    signal: 'network request with status 404 (wrong status / missing resource)',
  },

  {
    id: 'cors-blocked',
    regression: null,
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-cors', nameRe: /CORS blocked/, label: 'cors' } },
      { wait: 800 },
    ],
    mode: 'present',
    rx: /cors/i,
    signal: 'cross-origin request blocked (CORS) — fails or returns status 0',
  },

  {
    id: 'silent-dom-regression',
    regression: 'silent-dom-regression',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'overview' }, { wait: 300 }],
    mode: 'baseline',
    differs: true,
    signal: 'a KPI card silently removed (normalized snapshot must change)',
  },

  {
    id: 'route-transition-break',
    regression: 'route-transition-break',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'compose' }, { wait: 300 }],
    mode: 'absent',
    rx: /Generate|Compose a script|compose-prompt/i,
    signal: 'Compose view fails to render after nav',
  },

  {
    id: 'missing-modal',
    regression: 'missing-modal',
    expectDetect: true,
    observe: 'snapshot',
    steps: [
      { view: 'deployments' },
      { tap: { testid: 'new-deploy', nameRe: /New deploy/i, label: 'new-deploy' } },
      { wait: 300 },
    ],
    mode: 'absent',
    rx: /New deployment/i,
    signal: 'modal never opens',
  },

  {
    id: 'console-error-intact-ui',
    regression: null,
    expectDetect: true,
    observe: 'console',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-buggy', nameRe: /buggy|chart|crash/i, label: 'buggy' } },
      { wait: 300 },
    ],
    mode: 'present',
    rx: /Render crash in <ChartWidget>/,
    signal: 'console.error on click',
  },

  {
    id: 'layout-shift',
    regression: 'layout-shift',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'overview' }, { wait: 300 }],
    mode: 'baseline',
    differs: true,
    signal: 'grid columns change (CLS) — a11y tree unchanged',
  },

  {
    id: 'broken-form-validation',
    regression: 'broken-form-validation',
    expectDetect: true,
    observe: 'snapshot',
    steps: [
      { view: 'deployments' },
      { tap: { testid: 'new-deploy', nameRe: /New deploy/i, label: 'new-deploy' } },
      { wait: 250 },
      { tap: { testid: 'deploy-submit', nameRe: /Deploy/, label: 'deploy-submit' } },
      { wait: 400 },
    ],
    mode: 'absent',
    rx: /New deployment/i,
    signal: 'empty submit accepted (modal closes / deploy fires)',
  },

  {
    id: 'cross-component-regression',
    regression: 'cross-component-regression',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'deployments' }, { wait: 300 }],
    skip: true,
    signal:
      'filter input no longer changes the table — requires reliable cross-tool table-state diffing (a typed-filter before/after row count). Deferred to Layer B agent-loop; NOT MEASURED in Layer A to avoid a per-tool counting heuristic that would bias the comparison.',
  },

  {
    id: 'network-timeout',
    regression: 'network-timeout',
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-timeout', nameRe: /Timeout/, label: 'timeout' } },
      { wait: 1600 },
    ],
    mode: 'present',
    rx: /timeout/i,
    signal: 'in-flight request to /api/broken/timeout',
  },

  {
    id: 'no-regression-control',
    regression: null,
    expectDetect: false,
    observe: 'snapshot',
    steps: [{ view: 'overview' }, { wait: 300 }],
    mode: 'present',
    rx: /\b(error|crash|failed|undefined)\b/i,
    signal: 'NONE — any detection is a false positive',
  },
];

async function runRecipe(adapter, steps, observe) {
  const cycle = [];
  for (const s of steps) {
    if (s.view) cycle.push(await adapter.gotoView(s.view));
    else if (s.tap) cycle.push(await adapter.tap(s.tap));
    else if (s.wait) await sleep(s.wait);
  }
  const obs = await adapter.observe(observe);
  cycle.push(obs);
  return { cycle, obsText: obs.text ?? '', allText: cycle.map((c) => c.text ?? '').join('\n') };
}

// Strip volatile tokens so a snapshot diff reflects SEMANTIC structure, not noise.
// Without this, all three tools embed per-session junk (Iris: session id/timestamps/cost;
// Playwright: a timestamped console-log filename + ref ids; DevTools: uids/msgids) that
// makes every snapshot byte-unique and produces false "differences".
function normalize(s) {
  return s
    .replace(/ref=e?\d+/g, 'ref=R')
    .replace(/\[ref=[^\]]*\]/g, '[ref]')
    .replace(/uid=\S+/g, 'uid=U')
    .replace(/msgid=\d+/g, 'msgid=M')
    .replace(/reqid=\S+/g, 'reqid=Q')
    .replace(/console-\d[\dT:.\-]*Z[^\s]*/g, 'console-LOG')
    .replace(/Console:\s*\d+\s*errors?,\s*\d+\s*warnings?/gi, 'Console:N')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/"(lastSeenMs|opened_at|t|bytes|tokens)":\s*\d+/g, '"$1":N')
    .replace(/\d+/g, '#')
    .trim();
}

function grade(sc, regr, baseline) {
  if (sc.skip) return { detected: null, detail: 'NOT MEASURED — see notes' };
  if (sc.mode === 'present') return sc.rx.test(regr.obsText);
  if (sc.mode === 'absent') return !sc.rx.test(regr.obsText);
  if (sc.mode === 'baseline') {
    if (sc.count) {
      const b = (baseline.obsText.match(sc.count) ?? []).length;
      const a = (regr.obsText.match(sc.count) ?? []).length;
      return { detected: a < b, detail: `baseline=${b} after=${a}` };
    }
    if (sc.differs) {
      const same = normalize(baseline.obsText) === normalize(regr.obsText);
      return {
        detected: !same,
        detail: same
          ? 'normalized snapshot IDENTICAL (change invisible to this observation)'
          : 'normalized snapshots differ (structural change visible)',
      };
    }
  }
  return false;
}

const rows = [];
const which = process.argv[2]; // optional single scenario id
const list = which ? SCENARIOS.filter((s) => s.id === which) : SCENARIOS;

for (const sc of list) {
  for (const tool of TOOLS) {
    const t0 = Date.now();
    let row = {
      scenario: sc.id,
      tool,
      layer: 'A',
      token_input: null,
      token_output: null,
      total_tokens: null,
      tokens_o200k: null,
      chars: null,
      bytes: null,
      latency_ms: null,
      verdict: '',
      detected_issue: null,
      expected_detect: sc.expectDetect,
      confidence: 0,
      notes: '',
    };
    if (sc.skip) {
      row.verdict = 'NOT MEASURED';
      row.notes = sc.signal;
      rows.push(row);
      console.log(JSON.stringify({ s: row.scenario, t: tool, v: 'NOT MEASURED' }));
      continue;
    }
    try {
      let baseline = null;
      // baseline scenarios: clean capture first
      if (sc.mode === 'baseline') {
        const a0 = makeAdapter(tool, URL);
        await a0.start();
        await a0.login();
        baseline = await runRecipe(a0, sc.steps, sc.observe);
        if (sc.differsAfterFilter) {
          // type a filter and re-observe to compare effect on the table
          if (tool !== 'devtools') {
            try {
              await a0.clickTestid('filter-search');
            } catch {
              /* */
            }
          }
        }
        await a0.stop();
      }
      if (sc.regression) inject(sc.regression);
      await sleep(400); // let vite HMR apply
      const a = makeAdapter(tool, URL);
      await a.start();
      await a.login();
      const regr = await runRecipe(a, sc.steps, sc.observe);
      await a.stop();
      if (sc.regression) revert(sc.regression);

      const g = grade(sc, regr, baseline);
      const detected = typeof g === 'object' ? g.detected : g;
      const detail = typeof g === 'object' ? g.detail : '';
      const cycleTokens = regr.cycle.reduce((n, c) => n + (c.tokens_o200k ?? 0), 0);
      const cycleChars = regr.cycle.reduce((n, c) => n + (c.chars ?? 0), 0);
      const cycleBytes = regr.cycle.reduce((n, c) => n + (c.bytes ?? 0), 0);
      row = {
        ...row,
        tokens_o200k: cycleTokens,
        chars: cycleChars,
        bytes: cycleBytes,
        latency_ms: Date.now() - t0,
        verdict: detected ? 'ISSUE DETECTED' : 'NO ISSUE FOUND',
        detected_issue: detected,
        confidence: detected === sc.expectDetect ? 1 : 0,
        notes: `obs=${sc.observe}; signal=${sc.signal}; ${detail}; calls=${regr.cycle.map((c) => c.call).join('>')}`,
        _obsTokens: regr.cycle.at(-1)?.tokens_o200k ?? null,
      };
    } catch (e) {
      if (sc.regression) {
        try {
          revert(sc.regression);
        } catch {
          /* */
        }
      }
      row.verdict = 'NOT MEASURED';
      row.notes = `error: ${String(e).slice(0, 200)}`;
    }
    rows.push(row);
    console.log(
      JSON.stringify({
        s: row.scenario,
        t: row.tool,
        det: row.detected_issue,
        exp: row.expected_detect,
        tok: row.tokens_o200k,
        ms: row.latency_ms,
        v: row.verdict,
        n: row.notes.slice(0, 90),
      }),
    );
  }
}
revertAll();
writeFileSync('bench/raw/observation-results.json', JSON.stringify(rows, null, 2));
console.log(`\nwrote ${rows.length} rows`);
process.exit(0);
