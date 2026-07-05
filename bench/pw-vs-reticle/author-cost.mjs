// Author-cost: the hidden tax of "write a Playwright test first, then run it".
//
// The Playwright path makes an agent AUTHOR a .spec.ts before it can verify anything — that
// authoring burns model tokens + wall-time up front, every time the intent changes. The Reticle
// path drives the MCP tools directly: ZERO authoring tokens, the model just looks/acts/observes.
//
// This measures the authoring side: for each bug we ask gpt-4o (plain chat, NO tools) to write a
// Playwright test that verifies the bug's intent given the app URL + the testids in play, and record
// authoring input/output tokens + wall-time. The Reticle baseline is 0 authoring tokens; if
// results-mcp.json exists (from mcp-head-to-head.mjs) we pull Reticle's actual drive-loop tokens for
// the same bug so the table shows "authoring tokens wasted" vs "tokens spent actually verifying".
//
// REQUIRES: OPENAI_API_KEY. Without it: prints NOT MEASURED and exits 0.
//   OPENAI_API_KEY=sk-... node bench/pw-vs-reticle/author-cost.mjs [--limit N]
//   node bench/pw-vs-reticle/author-cost.mjs            # no key -> NOT MEASURED, exit 0
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUGS, bugUrl, APP_ORIGIN } from './bugs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY;
const LLM_URL = process.env.BENCH_LLM_URL ?? 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.BENCH_LLM_MODEL ?? process.env.BENCH_OPENAI_MODEL ?? 'gpt-4o';
const PRICE = { inputPerM: Number(process.env.BENCH_LLM_IN ?? 2.5), outputPerM: Number(process.env.BENCH_LLM_OUT ?? 10), per: 1_000_000 };
const dollars = (inTok, outTok) =>
  (inTok / PRICE.per) * PRICE.inputPerM + (outTok / PRICE.per) * PRICE.outputPerM;
const argLimit = () => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) : 6;
};

if (!KEY) {
  console.log('NOT MEASURED (set OPENAI_API_KEY) — author-cost needs a real gpt-4o call to author the Playwright test.');
  process.exit(0);
}

// The testids the model needs to reference to write a faithful Playwright test for a bug.
function testidsFor(bug) {
  const ids = new Set([...(bug.setup ?? [])]);
  if (bug.check?.testid) ids.add(bug.check.testid);
  if (bug.check?.prep?.fill) ids.add(bug.check.prep.fill);
  for (const s of bug.check?.steps ?? []) ids.add(s);
  ids.add('login-email'); ids.add('login-password'); ids.add('login-submit');
  return [...ids];
}

async function callOpenAI(messages) {
  const r = await fetch(LLM_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1500 }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function authorPlaywright(bug) {
  const t0 = Date.now();
  const messages = [
    {
      role: 'system',
      content:
        'You are a senior QA engineer. Write a single self-contained Playwright test (TypeScript, @playwright/test) and output ONLY the .spec.ts code in one fenced block, no prose.',
    },
    {
      role: 'user',
      content:
        `App under test: ${APP_ORIGIN}/ (bug variant URL: ${bugUrl(bug.id)}). Login is pre-filled at admin@reticle.dev / password; submit via [data-testid="login-submit"].\n` +
        `Available testids (use [data-testid="…"] locators): ${testidsFor(bug).join(', ')}.\n` +
        `Write a Playwright test that verifies this property and FAILS if it is broken:\n"${bug.intent}"`,
    },
  ];
  const resp = await callOpenAI(messages);
  const inTok = resp.usage?.prompt_tokens ?? 0;
  const outTok = resp.usage?.completion_tokens ?? 0;
  const spec = resp.choices?.[0]?.message?.content ?? '';
  return { inTok, outTok, ms: Date.now() - t0, chars: spec.length };
}

// Reticle drive-loop cost for the same bug (buggy build), if the head-to-head run wrote it.
function reticleDrive(bug) {
  const f = path.join(__dirname, 'results-mcp.json');
  if (!existsSync(f)) return null;
  try {
    const { rows } = JSON.parse(readFileSync(f, 'utf8'));
    const r = rows.find((x) => x.bug === bug.id && x.tool === 'reticle' && x.variant === 'buggy');
    return r ? { tokens: r.total_tokens, ms: r.latency_ms, cost: r.cost_usd } : null;
  } catch { return null; }
}

(async () => {
  const _ids = (process.env.BENCH_IDS ?? "").split(",").map(s=>s.trim()).filter(Boolean);
  const bugs = _ids.length ? BUGS.filter(b=>_ids.includes(b.id)) : BUGS.slice(0, argLimit());
  const rows = [];
  for (const bug of bugs) {
    const a = await authorPlaywright(bug);
    const drive = reticleDrive(bug);
    const row = {
      bug: bug.id, category: bug.category,
      playwright: {
        authoring_input_tokens: a.inTok, authoring_output_tokens: a.outTok,
        authoring_total_tokens: a.inTok + a.outTok, authoring_ms: a.ms,
        authoring_cost_usd: +dollars(a.inTok, a.outTok).toFixed(4), spec_chars: a.chars,
      },
      reticle: {
        authoring_total_tokens: 0, authoring_ms: 0, authoring_cost_usd: 0,
        drive_total_tokens: drive?.tokens ?? null, drive_ms: drive?.ms ?? null,
        drive_cost_usd: drive?.cost ?? null,
      },
      tokens_wasted_authoring: a.inTok + a.outTok, // vs Reticle's 0
      ms_wasted_authoring: a.ms,
    };
    rows.push(row);
    console.log(JSON.stringify({
      bug: row.bug, pw_author_tok: row.playwright.authoring_total_tokens,
      pw_author_ms: row.playwright.authoring_ms, reticle_author_tok: 0,
      reticle_drive_tok: row.reticle.drive_total_tokens,
    }));
  }

  const totWastedTok = rows.reduce((a, r) => a + r.tokens_wasted_authoring, 0);
  const totWastedMs = rows.reduce((a, r) => a + r.ms_wasted_authoring, 0);
  const totWastedUsd = +rows.reduce((a, r) => a + r.playwright.authoring_cost_usd, 0).toFixed(4);
  const agg = {
    bugs: rows.length, model: MODEL,
    avgAuthoringTokens: Math.round(totWastedTok / (rows.length || 1)),
    avgAuthoringMs: Math.round(totWastedMs / (rows.length || 1)),
    totalTokensWastedAuthoring: totWastedTok,
    totalMsWastedAuthoring: totWastedMs,
    totalUsdWastedAuthoring: totWastedUsd,
    reticleAuthoringTokens: 0,
  };
  writeFileSync(path.join(__dirname, 'results-author.json'), JSON.stringify({ rows, agg, price: PRICE }, null, 2));

  const L = [];
  L.push('\n# Author-cost — Playwright "write the test first" tax vs Reticle direct-drive\n');
  L.push(`Model: ${MODEL}. Playwright path pays to author a .spec.ts before verifying; Reticle drives MCP tools directly (0 authoring tokens).\n`);
  L.push('| Bug | PW author tokens | PW author ms | PW author $ | Reticle author tokens | Reticle drive tokens |');
  L.push('|---|--:|--:|--:|--:|--:|');
  for (const r of rows) {
    L.push(`| ${r.bug} | ${r.playwright.authoring_total_tokens} | ${r.playwright.authoring_ms} | $${r.playwright.authoring_cost_usd} | 0 | ${r.reticle.drive_total_tokens ?? '—'} |`);
  }
  L.push('\n## Aggregate\n');
  L.push('| Metric | Value |');
  L.push('|---|--:|');
  L.push(`| Avg authoring tokens / bug (Playwright) | ${agg.avgAuthoringTokens} |`);
  L.push(`| Avg authoring time / bug (Playwright) | ${agg.avgAuthoringMs} ms |`);
  L.push(`| Total tokens wasted authoring | ${agg.totalTokensWastedAuthoring} |`);
  L.push(`| Total time wasted authoring | ${agg.totalMsWastedAuthoring} ms |`);
  L.push(`| Total $ wasted authoring | $${agg.totalUsdWastedAuthoring} |`);
  L.push(`| Reticle authoring tokens | 0 (direct drive) |`);
  const md = L.join('\n') + '\n';

  // Append to the head-to-head scorecard if present, else write a standalone one.
  const hh = path.join(__dirname, 'SCORECARD-MCP.md');
  if (existsSync(hh)) appendFileSync(hh, md);
  else writeFileSync(path.join(__dirname, 'SCORECARD-AUTHOR.md'), md);
  console.log(md);
  console.table(agg);
  process.exit(0);
})().catch((e) => { console.error('AUTHOR-COST ERROR', e); process.exit(1); });
