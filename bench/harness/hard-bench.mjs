// Hard UI-bug benchmark — the stress dataset. Each bug leaves the element PRESENT with the correct
// role+name (a DOM/a11y snapshot says "fine"); only computed style / geometry / occlusion reveals it.
// Fair 3-tool comparison: each tool observes the target its NATIVE way and we grade detection + cost.
//   Iris       → iris_inspect (one semantic call; cursor/opacity/box/occluded/bg built in).
//   Playwright → browser_evaluate (the agent must author a getComputedStyle function).
//   DevTools   → evaluate_script (same).
// Brutal-honest: we also record each competitor's JS-authoring input cost, and mark any tool that
// cannot surface a signal as a MISS — no flattering.
import { writeFileSync } from 'node:fs';
import { PlaywrightAdapter, DevtoolsAdapter, IrisAdapter, NAV } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const BASE = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The element each bug targets, the view it lives on, and how to decide the bug was detected from a
// computed-style/geometry observation { cursor, opacity, w, h, bg, occluded }.
const BUGS = [
  {
    id: 'cursor-missing',
    testid: 'nav-compose',
    view: null,
    detect: (o) => o.cursor !== undefined && o.cursor !== 'pointer',
  },
  {
    id: 'invisible',
    testid: 'new-deploy',
    view: 'deployments',
    detect: (o) => Number.parseFloat(o.opacity ?? '1') === 0,
  },
  {
    id: 'zero-size',
    testid: 'new-deploy',
    view: 'deployments',
    detect: (o) => o.w === 0 || o.h === 0,
  },
  { id: 'occluded', testid: 'new-deploy', view: 'deployments', detect: (o) => o.occluded === true },
  {
    id: 'color-regression',
    testid: 'new-deploy',
    view: 'deployments',
    detect: (o, clean) => clean !== undefined && o.bg !== undefined && o.bg !== clean,
  },
];

// The computed-style/geometry probe both competitors run via their evaluate tool (agent-authored JS).
function evalFn(testid) {
  return `() => { const el = document.querySelector('[data-testid="${testid}"]'); if (!el) return { missing: true }; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2); return { cursor: cs.cursor, opacity: cs.opacity, w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, occluded: !!(t && t !== el && !el.contains(t)) }; }`;
}

/** First balanced {...} starting at the first brace (so a trailing code block isn't swallowed). */
function firstBalanced(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// Tool results are wrapped: Playwright "### Result {json} ### Ran ```js …```", DevTools
// "returned: ```json {json} ```", Iris raw JSON. Prefer a fenced json block, else the first
// balanced object — a greedy match would grab the trailing code and fail to parse.
function parseJson(text) {
  if (text === undefined || text === null) return {};
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fence !== null ? fence[1] : firstBalanced(text);
  try {
    return candidate !== null ? JSON.parse(candidate) : {};
  } catch {
    return {};
  }
}

/** Iris: one iris_inspect → normalized observation. */
async function irisObserve(a, testid) {
  const q = parseJson((await a.c.callTool('iris_query', { by: 'testid', value: testid })).text);
  const ref = (q.elements ?? [])[0]?.ref;
  if (ref === undefined) return { obs: { missing: true }, tokens: 0 };
  const res = await a.c.callTool('iris_inspect', { ref });
  const j = parseJson(res.text);
  const s = j.styles ?? {};
  return {
    obs: {
      cursor: s.cursor,
      opacity: s.opacity,
      w: Math.round(j.box?.width ?? 0),
      h: Math.round(j.box?.height ?? 0),
      bg: s.backgroundColor,
      occluded: j.occluded,
    },
    tokens: measure(res.text ?? '').tokens_o200k,
  };
}

/** Competitor: evaluate the computed-style probe; the JS function string is real agent input cost. */
async function evalObserve(c, toolName, testid) {
  const fn = evalFn(testid);
  const res = await c.callTool(toolName, { function: fn });
  return {
    obs: parseJson(res.text),
    tokens: measure(res.text ?? '').tokens_o200k,
    inputTokens: measure(fn).tokens_o200k, // the agent had to author + send this JS
  };
}

async function withTool(adapter, fn) {
  // Retry start once: the first npx spawn of a competitor MCP can time out on a cold cache (an
  // apparatus flake, not a capability result) — a second attempt runs against the warm package.
  try {
    await adapter.start();
  } catch {
    await adapter.stop().catch(() => {});
    await sleep(1000);
    await adapter.start();
  }
  try {
    return await fn(adapter);
  } finally {
    await adapter.stop();
  }
}

/** The bugged demo URL for a given bug id (empty id → the clean app, for baselines). */
function buggedUrl(bugParam) {
  return bugParam === '' ? BASE : `${BASE}${BASE.includes('?') ? '&' : '?'}iris-bug=${bugParam}`;
}

// Land on the bug's view, logged in, WITH the bug applied. Fairness: every adapter is constructed
// with the bugged URL, so login (which re-navigates for Playwright/DevTools) keeps ?iris-bug — the
// earlier apparatus dropped it on login and made the competitors observe the healthy app.
async function reach(a, bug) {
  await a.login();
  await sleep(600);
  if (bug.view) {
    await a.gotoView(bug.view);
    await sleep(700);
  }
}

const rows = [];
for (const bug of BUGS) {
  const row = { bug: bug.id, tools: {} };
  // Iris (also grab a clean baseline bg first for color-regression).
  let cleanBg;
  await withTool(new IrisAdapter(buggedUrl('')), async (a) => {
    await reach(a, bug);
    cleanBg = (await irisObserve(a, bug.testid)).obs.bg;
  });
  await withTool(new IrisAdapter(buggedUrl(bug.id)), async (a) => {
    await reach(a, bug);
    const { obs, tokens } = await irisObserve(a, bug.testid);
    row.tools.iris = { detected: bug.detect(obs, cleanBg), tokens, obs };
  });
  // Playwright + DevTools via their evaluate tools — constructed with the bugged URL so login keeps it.
  for (const [name, Adapter, evalTool] of [
    ['playwright', PlaywrightAdapter, 'browser_evaluate'],
    ['devtools', DevtoolsAdapter, 'evaluate_script'],
  ]) {
    try {
      await withTool(new Adapter(buggedUrl(bug.id)), async (a) => {
        await reach(a, bug);
        const { obs, tokens, inputTokens } = await evalObserve(a.c, evalTool, bug.testid);
        row.tools[name] = { detected: bug.detect(obs, cleanBg), tokens, inputTokens, obs };
      });
    } catch (e) {
      row.tools[name] = { detected: null, error: String(e).slice(0, 100) };
    }
  }
  console.log(
    JSON.stringify({
      bug: row.bug,
      iris: row.tools.iris?.detected,
      playwright: row.tools.playwright?.detected,
      devtools: row.tools.devtools?.detected,
    }),
  );
  rows.push(row);
}

const summary = { layer: 'Hard (visually-broken-but-present UI bugs)', baseUrl: BASE, rows };
writeFileSync('bench/raw/hard-bench.json', JSON.stringify(summary, null, 2));
const det = (t) => rows.filter((r) => r.tools[t]?.detected === true).length;
console.log(
  `\n=== detection (of ${rows.length}): iris ${det('iris')} | playwright ${det('playwright')} | devtools ${det('devtools')} ===`,
);
process.exit(0);
