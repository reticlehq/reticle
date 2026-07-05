// MCP head-to-head: a REAL gpt-4o agent loop drives Playwright-MCP vs Reticle-MCP over the same
// bug registry, on both the buggy and the clean build. Measures the FULL agent cost each tool
// imposes on the model: input/output/total tokens (authoritative usage), tool-call rounds (turns),
// wall-clock latency, the model's verdict, whether it correctly detected the bug (buggy build) or
// false-alarmed (clean build), and the estimated $ cost at gpt-4o rates.
//
// Reuses the existing infra: McpStdioClient (bench/harness/mcp-client.mjs), the OpenAI tool-use
// loop shape from bench/harness/openai-agent-loop.mjs, ensureApp() from run.mjs, and the BUGS
// registry from bugs.mjs. The reticle MCP server runs in --drive mode (its own browser) exactly
// like openai-agent-loop.mjs — the model just calls reticle_* tools with no session plumbing.
//
// REQUIRES: OPENAI_API_KEY. Without it: prints NOT MEASURED and exits 0 (never fabricates numbers).
//   OPENAI_API_KEY=sk-... node bench/pw-vs-reticle/mcp-head-to-head.mjs [--limit N]
//   node bench/pw-vs-reticle/mcp-head-to-head.mjs            # no key -> NOT MEASURED, exit 0
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../harness/mcp-client.mjs';
import { BUGS, bugUrl } from './bugs.mjs';
import { ensureApp } from './run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
// Provider-agnostic (OpenAI-compatible). DeepSeek: DEEPSEEK_API_KEY + BENCH_LLM_URL=https://api.deepseek.com/v1/chat/completions BENCH_LLM_MODEL=deepseek-chat.
const KEY = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY;
const LLM_URL = process.env.BENCH_LLM_URL ?? 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.BENCH_LLM_MODEL ?? process.env.BENCH_OPENAI_MODEL ?? 'gpt-4o';
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? 14);
const RETICLE_PORT = process.env.BENCH_HH_RETICLE_PORT ?? '4461';
const RETICLE_READY_MS = Number(process.env.BENCH_RETICLE_READY_MS ?? '3500');

// Per-token pricing (USD). Defaults = gpt-4o; override per provider (deepseek-chat ≈ 0.27 in / 1.10 out).
const PRICE = { inputPerM: Number(process.env.BENCH_LLM_IN ?? 2.5), outputPerM: Number(process.env.BENCH_LLM_OUT ?? 10), per: 1_000_000 };
const dollars = (inTok, outTok) =>
  (inTok / PRICE.per) * PRICE.inputPerM + (outTok / PRICE.per) * PRICE.outputPerM;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argLimit = () => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) : 6;
};

if (!KEY) {
  console.log('NOT MEASURED (set OPENAI_API_KEY) — mcp-head-to-head needs a real gpt-4o agent loop.');
  process.exit(0);
}

// MCP server per tool. Reticle bakes the driven URL into --drive, so it is spawned per cell.
function serverFor(toolKey, url) {
  if (toolKey === 'playwright_mcp') {
    return { command: 'npx', args: ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated'], env: {} };
  }
  return {
    command: 'node',
    args: [path.join(REPO, 'packages/server/dist/cli.js'), 'mcp', '--port', RETICLE_PORT, '--drive', url],
    env: { RETICLE_PORT, RETICLE_TOOL_PROFILE: process.env.BENCH_RETICLE_PROFILE ?? 'full' },
  };
}

// Synthetic verdict tool injected into every tool list — the model MUST end by calling it.
const VERDICT_TOOL = {
  type: 'function',
  function: {
    name: 'report_verdict',
    description:
      'Call this once you have decided. holds=true if the property under test holds, false if it is broken. evidence: one sentence citing what you observed.',
    parameters: {
      type: 'object',
      properties: {
        holds: { type: 'boolean', description: 'true = property holds, false = broken' },
        evidence: { type: 'string', description: 'one sentence of evidence' },
      },
      required: ['holds', 'evidence'],
    },
  },
};

function mcpToolsToOpenAI(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description ?? '').slice(0, 1000),
      parameters:
        t.inputSchema && t.inputSchema.type === 'object'
          ? t.inputSchema
          : { type: 'object', properties: {} },
    },
  }));
}

async function callOpenAI(messages, tools) {
  const r = await fetch(LLM_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', max_tokens: 1024 }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Run one (bug, tool, variant) agent loop. Returns a fully-costed row.
async function runCell(bug, toolKey, variant) {
  const url = variant === 'buggy' ? bugUrl(bug.id) : bugUrl('');
  const cfg = serverFor(toolKey, url);
  const client = new McpStdioClient(cfg.command, cfg.args, cfg.env);
  const t0 = Date.now();
  let inTok = 0, outTok = 0, turns = 0, verdict = null, evidence = '';
  try {
    await client.start();
    if (toolKey === 'reticle') await sleep(RETICLE_READY_MS); // driven browser load + SDK connect
    const tools = [...mcpToolsToOpenAI(await client.listTools()), VERDICT_TOOL];
    const messages = [
      {
        role: 'system',
        content:
          'You are a browser verification agent. Use the provided tools to look, act, and observe, then decide. When you have enough evidence, call report_verdict exactly once. Do not guess without observing.',
      },
      {
        role: 'user',
        content: `Verify: ${bug.intent}. Navigate to ${url} (log in with admin@reticle.dev / password if a login form appears — the fields are pre-filled). Use the tools to decide if this holds or is broken. End by calling report_verdict with {holds:boolean, evidence:string}.`,
      },
    ];
    for (turns = 0; turns < MAX_TURNS; turns++) {
      const resp = await callOpenAI(messages, tools);
      inTok += resp.usage?.prompt_tokens ?? 0;
      outTok += resp.usage?.completion_tokens ?? 0;
      const msg = resp.choices?.[0]?.message;
      if (!msg) break;
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) break;
      let done = false;
      for (const tc of calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* */ }
        if (tc.function.name === 'report_verdict') {
          verdict = typeof args.holds === 'boolean' ? args.holds : null;
          evidence = String(args.evidence ?? '').slice(0, 300);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'recorded' });
          done = true;
          continue;
        }
        let content = '';
        try {
          const out = await client.callTool(tc.function.name, args, 60000);
          content = out.text.slice(0, 8000);
        } catch (e) {
          content = `error: ${String(e).slice(0, 200)}`;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
      if (done) break;
    }
    // detected = verdict correctly says broken on the buggy build.
    const detected = variant === 'buggy' ? verdict === false : null;
    const falsePositive = variant === 'clean' ? verdict === false : null;
    return {
      bug: bug.id, category: bug.category, tool: toolKey, variant, model: MODEL,
      input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok,
      turns, latency_ms: Date.now() - t0, cost_usd: dollars(inTok, outTok),
      verdict_holds: verdict, detected, false_positive: falsePositive,
      evidence: evidence.slice(0, 200),
    };
  } catch (e) {
    return {
      bug: bug.id, category: bug.category, tool: toolKey, variant, model: MODEL,
      input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok,
      turns, latency_ms: Date.now() - t0, cost_usd: dollars(inTok, outTok),
      verdict_holds: null, detected: null, false_positive: null,
      evidence: `error: ${String(e).slice(0, 160)}`,
    };
  } finally {
    await client.stop();
    if (toolKey === 'reticle') {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('node', [path.join(REPO, 'packages/server/dist/cli.js'), 'stop', '--port', RETICLE_PORT, '--quiet'], { stdio: 'ignore' });
      } catch { /* */ }
    }
  }
}

function aggregate(rows) {
  const byTool = {};
  for (const tool of ['playwright_mcp', 'reticle']) {
    const mine = rows.filter((r) => r.tool === tool);
    const buggy = mine.filter((r) => r.variant === 'buggy');
    const clean = mine.filter((r) => r.variant === 'clean');
    const n = mine.length || 1;
    byTool[tool] = {
      detectionRate: `${buggy.filter((r) => r.detected === true).length}/${buggy.length}`,
      falsePositives: clean.filter((r) => r.false_positive === true).length,
      avgTokens: Math.round(mine.reduce((a, r) => a + r.total_tokens, 0) / n),
      avgTurns: +(mine.reduce((a, r) => a + r.turns, 0) / n).toFixed(1),
      avgLatencyMs: Math.round(mine.reduce((a, r) => a + r.latency_ms, 0) / n),
      avgCostUsd: +(mine.reduce((a, r) => a + r.cost_usd, 0) / n).toFixed(4),
      totalCostUsd: +mine.reduce((a, r) => a + r.cost_usd, 0).toFixed(4),
    };
  }
  return byTool;
}

function scorecard(agg) {
  const P = agg.playwright_mcp, R = agg.reticle;
  const L = [];
  L.push('# MCP head-to-head — gpt-4o agent loop (Playwright-MCP vs Reticle-MCP)\n');
  L.push(`Model: ${MODEL}. Each bug run on both the buggy and clean build, both tools. Cost at gpt-4o rates ($${PRICE.inputPerM}/1M in, $${PRICE.outputPerM}/1M out).\n`);
  L.push('| Metric | Playwright-MCP | Reticle-MCP |');
  L.push('|---|--:|--:|');
  L.push(`| Detection rate (buggy) | ${P.detectionRate} | ${R.detectionRate} |`);
  L.push(`| False positives (clean) | ${P.falsePositives} | ${R.falsePositives} |`);
  L.push(`| Avg tokens / run | ${P.avgTokens} | ${R.avgTokens} |`);
  L.push(`| Avg turns / run | ${P.avgTurns} | ${R.avgTurns} |`);
  L.push(`| Avg latency / run | ${P.avgLatencyMs} ms | ${R.avgLatencyMs} ms |`);
  L.push(`| Avg $ / run | $${P.avgCostUsd} | $${R.avgCostUsd} |`);
  L.push(`| Total $ | $${P.totalCostUsd} | $${R.totalCostUsd} |`);
  return L.join('\n') + '\n';
}

(async () => {
  const bugs = BUGS.slice(0, argLimit());
  const procs = await ensureApp();
  await sleep(1000);
  const rows = [];
  for (const bug of bugs) {
    for (const variant of ['buggy', 'clean']) {
      for (const tool of ['playwright_mcp', 'reticle']) {
        const row = await runCell(bug, tool, variant);
        rows.push(row);
        console.log(JSON.stringify({
          bug: row.bug, tool: row.tool, v: row.variant, tot: row.total_tokens,
          turns: row.turns, holds: row.verdict_holds, det: row.detected, $: row.cost_usd.toFixed(4),
        }));
      }
    }
  }
  const agg = aggregate(rows);
  writeFileSync(path.join(__dirname, 'results-mcp.json'), JSON.stringify({ rows, agg, price: PRICE }, null, 2));
  const md = scorecard(agg);
  writeFileSync(path.join(__dirname, 'SCORECARD-MCP.md'), md);
  console.log('\n' + md);
  console.table(agg);
  for (const p of procs) { try { process.kill(-p.pid); } catch { /* */ } }
  process.exit(0);
})().catch((e) => { console.error('HEAD-TO-HEAD ERROR', e); process.exit(1); });
