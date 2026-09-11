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
// Anthropic is checked first only because it is the key this repo actually carries; either provider
// runs the identical loop. PROVIDER is derived from which key is present unless pinned explicitly.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY =
  process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY;
const PROVIDER =
  process.env.BENCH_PROVIDER ?? (ANTHROPIC_KEY !== undefined ? 'anthropic' : 'openai');
const KEY = PROVIDER === 'anthropic' ? ANTHROPIC_KEY : OPENAI_KEY;
const LLM_URL = process.env.BENCH_LLM_URL ?? 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = process.env.BENCH_ANTHROPIC_URL ?? 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = PROVIDER === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o';
const MODEL = process.env.BENCH_LLM_MODEL ?? process.env.BENCH_OPENAI_MODEL ?? DEFAULT_MODEL;
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? 14);
// MUST match apps/bench-app's baked-in default (its vite.config.ts reads RETICLE_PORT at dev-server
// start). This said 4461 against the app's 4460 and silently invalidated every Reticle cell.
const RETICLE_PORT = process.env.BENCH_HH_RETICLE_PORT ?? '4460';
const RETICLE_READY_MS = Number(process.env.BENCH_RETICLE_READY_MS ?? '3500');

// Per-token pricing (USD). Defaults = gpt-4o; override per provider (deepseek-chat ≈ 0.27 in / 1.10 out).
const DEFAULT_PRICE = PROVIDER === 'anthropic' ? { in: 1, out: 5 } : { in: 2.5, out: 10 };
const PRICE = {
  inputPerM: Number(process.env.BENCH_LLM_IN ?? DEFAULT_PRICE.in),
  outputPerM: Number(process.env.BENCH_LLM_OUT ?? DEFAULT_PRICE.out),
  per: 1_000_000,
};
const dollars = (inTok, outTok) =>
  (inTok / PRICE.per) * PRICE.inputPerM + (outTok / PRICE.per) * PRICE.outputPerM;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argLimit = () => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) : 6;
};

if (!KEY) {
  console.log(
    'NOT MEASURED (set ANTHROPIC_API_KEY or OPENAI_API_KEY) — mcp-head-to-head needs a real agent loop.',
  );
  process.exit(0);
}

/** Competitor versions are pinned so a run is reproducible; bump deliberately, never float. */
export const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.79';
export const DEVTOOLS_MCP = 'chrome-devtools-mcp@1.7.0';

/** The refusal Reticle returns when nothing is attached. Its presence means the cell measured NOTHING. */
const NO_SESSION_MARKER = 'no browser session connected';

/** Arms to run. Narrow with BENCH_TOOLS when only one side changed — the others are unaffected. */
export const TOOLS = (process.env.BENCH_TOOLS ?? 'playwright_mcp,devtools_mcp,reticle')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// MCP server per tool. Reticle bakes the driven URL into --drive, so it is spawned per cell.
function serverFor(toolKey, url) {
  if (toolKey === 'playwright_mcp') {
    return {
      command: 'npx',
      args: ['-y', PLAYWRIGHT_MCP, '--headless', '--isolated'],
      env: {},
    };
  }
  if (toolKey === 'devtools_mcp') {
    return {
      command: 'npx',
      args: ['-y', DEVTOOLS_MCP, '--headless', '--isolated'],
      env: {},
    };
  }
  return {
    command: 'node',
    args: [
      path.join(REPO, 'packages/server/dist/cli.js'),
      'mcp',
      '--port',
      RETICLE_PORT,
      '--drive',
      url,
    ],
    env: {
      RETICLE_PORT,
      // Opt the Reticle arm onto the lean verify surface, to measure what a smaller advertised
      // surface costs in DETECTION rather than only in tokens. The retired `dynamic` profile was
      // removed on exactly this question and the answer has never been re-taken.
      ...(process.env.BENCH_RETICLE_VERIFY === '1' ? { RETICLE_VERIFY_SURFACE: '1' } : {}),
      // The SHIPPED default surface, not the full 48. Advertising everything re-sends 48 schemas on
      // every turn and roughly tripled Reticle's input tokens against competitors running their own
      // defaults — a harness setting scoring as a property of the tool, and not what a user gets.
      RETICLE_ADVERTISE_ALL_TOOLS: process.env.BENCH_RETICLE_ADVERTISE_ALL ?? '0',
    },
  };
}

// Synthetic verdict tool injected into every tool list — the model MUST end by calling it.
/** The one decision every cell must end on, expressed once and formatted per provider. */
const VERDICT_NAME = 'report_verdict';
const VERDICT_DESC =
  'Call this once you have decided. holds=true if the property under test holds, false if it is broken. evidence: one sentence citing what you observed.';
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    holds: { type: 'boolean', description: 'true = property holds, false = broken' },
    evidence: { type: 'string', description: 'one sentence of evidence' },
  },
  required: ['holds', 'evidence'],
};

const SYSTEM =
  'You are a browser verification agent. Use the provided tools to look, act, and observe, then decide. ' +
  `When you have enough evidence, call ${VERDICT_NAME} exactly once. Do not guess without observing.`;

/**
 * Two model providers, one loop.
 *
 * The harness was written against OpenAI chat/completions. Anthropic's Messages API differs in the
 * tool schema key, where the system prompt lives, how the assistant turn is echoed back, and how tool
 * results are returned (a user turn carrying tool_result blocks, not one message per call). Keeping
 * both behind this shape means the measured loop, the turn cap and the forced-verdict rule stay
 * IDENTICAL across providers, which is the only way a cross-provider number would mean anything.
 */
const PROVIDERS = {
  openai: {
    tools: (mcp) => [
      ...mcp.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: (t.description ?? '').slice(0, 1000),
          parameters:
            t.inputSchema && t.inputSchema.type === 'object'
              ? t.inputSchema
              : { type: 'object', properties: {} },
        },
      })),
      {
        type: 'function',
        function: { name: VERDICT_NAME, description: VERDICT_DESC, parameters: VERDICT_SCHEMA },
      },
    ],
    seed: (task) => [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: task },
    ],
    async send(messages, tools) {
      const r = await fetch(LLM_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools,
          tool_choice: 'auto',
          max_tokens: 1024,
        }),
      });
      if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      const msg = j.choices?.[0]?.message ?? null;
      const calls = (msg?.tool_calls ?? []).map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* malformed args count as empty, same as before */
        }
        return { id: tc.id, name: tc.function.name, args };
      });
      return {
        inTok: j.usage?.prompt_tokens ?? 0,
        outTok: j.usage?.completion_tokens ?? 0,
        raw: msg,
        calls,
        ended: msg === null,
      };
    },
    pushAssistant: (messages, raw) => messages.push(raw),
    pushResults: (messages, results) => {
      for (const r of results)
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    },
    pushUser: (messages, text) => messages.push({ role: 'user', content: text }),
  },

  anthropic: {
    tools: (mcp) => [
      ...mcp.map((t) => ({
        name: t.name,
        description: (t.description ?? '').slice(0, 900),
        input_schema:
          t.inputSchema && t.inputSchema.type === 'object'
            ? t.inputSchema
            : { type: 'object', properties: {} },
      })),
      { name: VERDICT_NAME, description: VERDICT_DESC, input_schema: VERDICT_SCHEMA },
    ],
    seed: (task) => [{ role: 'user', content: task }],
    async send(messages, tools) {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages }),
      });
      if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      const content = Array.isArray(j.content) ? j.content : [];
      return {
        inTok: j.usage?.input_tokens ?? 0,
        outTok: j.usage?.output_tokens ?? 0,
        raw: content,
        calls: content
          .filter((c) => c.type === 'tool_use')
          .map((c) => ({ id: c.id, name: c.name, args: c.input ?? {} })),
        ended: content.length === 0,
      };
    },
    pushAssistant: (messages, raw) => messages.push({ role: 'assistant', content: raw }),
    // Anthropic requires EVERY tool_use in a turn to be answered in ONE following user turn.
    pushResults: (messages, results) =>
      messages.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
        })),
      }),
    pushUser: (messages, text) => messages.push({ role: 'user', content: text }),
  },
};

const P = PROVIDERS[PROVIDER];

/**
 * The route to the screen the property lives on, handed to every tool identically.
 *
 * Each bug in the registry carries a `setup` list of testids to click — `login-submit` then
 * `nav-compose`, and so on — and the SCRIPT harnesses drive exactly that before checking anything.
 * The MCP harness dropped it and told the agent only to navigate to the app and log in, which meant
 * the model was asked to verify a property on a page it was never told to open.
 *
 * Measured cost of that omission: 86 of 180 cells sat at exactly the turn cap, and the eight bugs
 * that NO tool could decide in any cell were all `nav-compose` or `nav-diagnostics`, while the three
 * every tool decided were all `nav-deployments` — the page the app already lands on after login. The
 * benchmark was measuring whether an agent can find a screen, and the deep bugs where the tools
 * actually differ are precisely the ones it never reached.
 *
 * This is navigation, not the answer. It says which screen to open, never what to look for or what
 * would count as broken, and every tool gets the same sentence.
 */
function setupHint(bug) {
  const steps = Array.isArray(bug.setup) ? bug.setup : [];
  if (steps.length === 0) return '';
  const clicks = steps.map((testid) => `data-testid="${testid}"`).join(', then ');
  return ` To reach the screen this property lives on, click ${clicks} in that order first.`;
}

// Run one (bug, tool, variant) agent loop. Returns a fully-costed row.
async function runCell(bug, toolKey, variant) {
  const url = variant === 'buggy' ? bugUrl(bug.id) : bugUrl('');
  const cfg = serverFor(toolKey, url);
  const client = new McpStdioClient(cfg.command, cfg.args, cfg.env);
  const t0 = Date.now();
  let inTok = 0,
    outTok = 0,
    turns = 0,
    verdict = null,
    evidence = '';
  // Reticle-only: did any tool call actually come back with an observation? A cell where every call
  // was refused for want of a session is not a detection and not a false positive, it is a void run.
  let observed = toolKey === 'reticle' ? false : true;
  /** Did this cell answer only because the budget ran out? Reported, never silently blended in. */
  let forcedAtCap = false;
  try {
    // The server's own `instructions` are part of what it advertises, and a real MCP client puts
    // them in front of the model. This harness discarded them and sent only its own system prompt,
    // so every number it has produced was measured with the server's guidance ABSENT — the verdict
    // discipline, the hand-back protocol, the shared-argument vocabulary, none of it reached the
    // model. Measuring a change that moves text INTO that block would have scored a deletion.
    const init = await client.start();
    const serverInstructions =
      'string' === typeof init?.instructions && init.instructions.length > 0
        ? init.instructions
        : '';
    if (toolKey === 'reticle') await sleep(RETICLE_READY_MS); // driven browser load + SDK connect
    const tools = P.tools(await client.listTools());
    const task =
      `Verify: ${bug.intent}. Navigate to ${url} (log in with admin@reticle.dev / password if a ` +
      `login form appears — the fields are pre-filled). Use the tools to decide if this holds or is ` +
      `broken.${setupHint(bug)} End by calling ${VERDICT_NAME} with {holds:boolean, evidence:string}.`;
    // Server instructions ride ahead of the task, the way a client would place them.
    const messages = P.seed(
      serverInstructions.length > 0 ? `${serverInstructions}\n\n---\n\n${task}` : task,
    );
    let forced = false;
    for (turns = 0; turns < MAX_TURNS; turns++) {
      const resp = await P.send(messages, tools);
      inTok += resp.inTok;
      outTok += resp.outTok;
      if (resp.ended) break;
      P.pushAssistant(messages, resp.raw);
      // Model replied with prose instead of a tool call: if it never gave a verdict, force one
      // (fair to every tool — otherwise a chatty turn scores as a non-detection).
      if (resp.calls.length === 0) {
        if (verdict === null && !forced) {
          forced = true;
          P.pushUser(
            messages,
            `You did not call ${VERDICT_NAME}. Based only on what you have already observed, call ` +
              `${VERDICT_NAME} NOW — holds:true if the property holds, holds:false if it is broken.`,
          );
          continue;
        }
        break;
      }
      // Every tool_use in a turn must be answered, including the verdict call, or Anthropic rejects
      // the next request. So results are collected for ALL calls and flushed once, then we stop.
      const results = [];
      let done = false;
      for (const tc of resp.calls) {
        if (tc.name === VERDICT_NAME) {
          verdict = typeof tc.args.holds === 'boolean' ? tc.args.holds : null;
          evidence = String(tc.args.evidence ?? '').slice(0, 300);
          results.push({ id: tc.id, content: 'recorded' });
          done = true;
          continue;
        }
        let content = '';
        try {
          const out = await client.callTool(tc.name, tc.args, 60000);
          content = out.text.slice(0, 8000);
          if (!content.includes(NO_SESSION_MARKER)) observed = true;
        } catch (e) {
          content = `error: ${String(e).slice(0, 200)}`;
        }
        results.push({ id: tc.id, content });
      }
      P.pushResults(messages, results);
      if (done) break;
    }
    // Out of turns without a decision is NOT a result, and letting it stand as one hides the single
    // most interesting outcome this benchmark can produce.
    //
    // A tool that structurally cannot see a bug should end up saying the property HOLDS — a false
    // green, which is the finding. Instead it kept calling tools until the cap and returned nothing,
    // which scores as neither a catch nor a false alarm. Measured: 86 of 180 cells sat at exactly
    // the cap, and every cell of `mutation-leak` (a value the app never renders) did, for all three
    // tools — so the one class where the tools genuinely differ produced no data at all.
    //
    // So the budget ending forces the same decision a real agent would have to make: answer from
    // what you already observed. The tools are withheld on this call so it cannot be spent looking
    // further, and it is charged to the cell like any other turn.
    if (verdict === null && observed) {
      P.pushUser(
        messages,
        `You are out of tool budget. Do not call any tool other than ${VERDICT_NAME}. Based ONLY on ` +
          `what you have already observed, call ${VERDICT_NAME} now — holds:true if you saw nothing ` +
          `wrong, holds:false if you did.`,
      );
      const last = await P.send(messages, P.tools([]));
      inTok += last.inTok;
      outTok += last.outTok;
      const call = last.calls.find((c) => c.name === VERDICT_NAME);
      if (call !== undefined) {
        verdict = typeof call.args.holds === 'boolean' ? call.args.holds : null;
        evidence = String(call.args.evidence ?? '').slice(0, 300);
        forcedAtCap = true;
      }
    }

    // detected = verdict correctly says broken on the buggy build.
    //
    // A cell that ran out of turns without ever calling report_verdict is NOT a result, and scoring
    // it as one is silently biased: on a buggy build a null reads as "missed it" and counts against
    // the tool, while the identical null on a clean build reads as "no false alarm" and counts for
    // it. Same non-answer, opposite sign. Null stays null and is reported on its own line.
    //
    // A trap bug is not a bug. Its "buggy" build is a HEALTHY build that merely looks alarming (a
    // timestamp that rewrites itself, an ambient animation), and the correct answer there is that the
    // property holds. Scoring it as a detection would reward flagging a working app, so a trap's
    // buggy variant is graded on the false-positive axis exactly like a clean build.
    const isTrap = bug.trap === true;
    const gradesAsClean = variant === 'clean' || isTrap;
    const detected = !gradesAsClean && verdict !== null ? verdict === false : null;
    const falsePositive = gradesAsClean && verdict !== null ? verdict === false : null;
    return {
      bug: bug.id,
      category: bug.category,
      tool: toolKey,
      variant,
      model: MODEL,
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: inTok + outTok,
      turns,
      latency_ms: Date.now() - t0,
      cost_usd: dollars(inTok, outTok),
      verdict_holds: verdict,
      detected,
      false_positive: falsePositive,
      observed,
      forced_at_cap: forcedAtCap,
      evidence: evidence.slice(0, 200),
    };
  } catch (e) {
    return {
      bug: bug.id,
      category: bug.category,
      tool: toolKey,
      variant,
      model: MODEL,
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: inTok + outTok,
      turns,
      latency_ms: Date.now() - t0,
      cost_usd: dollars(inTok, outTok),
      verdict_holds: null,
      detected: null,
      false_positive: null,
      observed,
      forced_at_cap: forcedAtCap,
      evidence: `error: ${String(e).slice(0, 160)}`,
    };
  } finally {
    await client.stop();
    if (toolKey === 'reticle') {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync(
          'node',
          [
            path.join(REPO, 'packages/server/dist/cli.js'),
            'stop',
            '--port',
            RETICLE_PORT,
            '--quiet',
          ],
          { stdio: 'ignore' },
        );
      } catch {
        /* */
      }
    }
  }
}

/**
 * Refuse to measure a Reticle arm that cannot see the app.
 *
 * Without this the harness happily produces a full scorecard out of a daemon nothing ever connected
 * to: the model, told to verify and shown nothing, answers "broken" every time, which scores as a
 * perfect detection rate on the buggy builds and a wall of false positives on the clean ones. Both
 * numbers are wrong and neither looks wrong. A benchmark that measured nothing has to go RED.
 */
async function preflightReticle(url) {
  const cfg = serverFor('reticle', url);
  const client = new McpStdioClient(cfg.command, cfg.args, cfg.env);
  try {
    await client.start();
    await sleep(RETICLE_READY_MS);
    // A refused tool REJECTS rather than returning text, so the marker has to be looked for in both.
    const text = await client
      .callTool('reticle_snapshot', {}, 60000)
      .then((out) => out.text)
      .catch((e) => String(e));
    if (text.includes(NO_SESSION_MARKER)) {
      throw new Error(
        `PREFLIGHT FAILED: no app session on port ${RETICLE_PORT}.\n` +
          `apps/bench-app bakes RETICLE_PORT in at dev-server start, so a bench-app already running ` +
          `on a different port cannot be re-pointed by env alone. Kill it and re-run, or set ` +
          `BENCH_HH_RETICLE_PORT to the port it was started with.\n` +
          `Refusing to measure: every Reticle cell would score a verdict the model could not observe.`,
      );
    }
  } finally {
    await client.stop();
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(
        'node',
        [path.join(REPO, 'packages/server/dist/cli.js'), 'stop', '--port', RETICLE_PORT, '--quiet'],
        { stdio: 'ignore' },
      );
    } catch {
      /* */
    }
  }
}

function aggregate(rows) {
  const byTool = {};
  for (const tool of TOOLS) {
    const mine = rows.filter((r) => r.tool === tool);
    const buggy = mine.filter((r) => r.variant === 'buggy');
    const clean = mine.filter((r) => r.variant === 'clean');
    const n = mine.length || 1;
    byTool[tool] = {
      detectionRate: `${buggy.filter((r) => r.detected === true).length}/${buggy.filter((r) => r.detected !== null).length}`,
      falsePositives: `${clean.filter((r) => r.false_positive === true).length}/${clean.filter((r) => r.false_positive !== null).length}`,
      noVerdict: mine.filter((r) => r.verdict_holds === null).length,
      forcedAtCap: mine.filter((r) => r.forced_at_cap === true).length,
      voidRuns: mine.filter((r) => r.observed === false).length,
      avgTokens: Math.round(mine.reduce((a, r) => a + r.total_tokens, 0) / n),
      avgTurns: +(mine.reduce((a, r) => a + r.turns, 0) / n).toFixed(1),
      avgLatencyMs: Math.round(mine.reduce((a, r) => a + r.latency_ms, 0) / n),
      avgCostUsd: +(mine.reduce((a, r) => a + r.cost_usd, 0) / n).toFixed(4),
      totalCostUsd: +mine.reduce((a, r) => a + r.cost_usd, 0).toFixed(4),
    };
  }
  return byTool;
}

function scorecard(agg, rows) {
  const cols = TOOLS;
  const name = {
    playwright_mcp: `Playwright-MCP (${PLAYWRIGHT_MCP.split('@').pop()})`,
    devtools_mcp: `DevTools-MCP (${DEVTOOLS_MCP.split('@').pop()})`,
    reticle: 'Reticle-MCP',
  };
  const row = (label, f) => `| ${label} | ${cols.map((t) => f(agg[t])).join(' | ')} |`;
  const L = [];
  L.push('# MCP head-to-head: Reticle vs Playwright-MCP vs Chrome-DevTools-MCP\n');
  L.push(
    `A real \`${MODEL}\` agent loop drives each MCP server over the bug registry, on the buggy AND the ` +
      `clean build of the same app. Every number below is the FULL cost the tool imposes on the model.\n`,
  );
  L.push(
    `Bugs: ${new Set(rows.map((r) => r.bug)).size}. Cells: ${rows.length}. Max turns: ${MAX_TURNS}.\n`,
  );
  L.push(`| Metric | ${cols.map((t) => name[t]).join(' | ')} |`);
  L.push(`|---|${cols.map(() => '--:').join('|')}|`);
  L.push(row('Detection rate (buggy)', (a) => a.detectionRate));
  L.push(row('False positives (clean)', (a) => a.falsePositives));
  L.push(row('No verdict (hit turn cap)', (a) => a.noVerdict));
  L.push(row('Decided only at the cap', (a) => a.forcedAtCap));
  L.push(row('Avg tokens / run', (a) => a.avgTokens.toLocaleString('en-US')));
  L.push(row('Avg turns / run', (a) => a.avgTurns));
  L.push(row('Avg latency / run', (a) => `${a.avgLatencyMs} ms`));
  L.push(row('Avg $ / run', (a) => `$${a.avgCostUsd}`));
  L.push(row('Total $', (a) => `$${a.totalCostUsd}`));
  L.push(row('Void runs (observed nothing)', (a) => a.voidRuns));
  L.push('');
  L.push(
    'Rates are over cells that reached a verdict. A cell that burned every turn without deciding is ' +
      'counted on its own line and excluded from both rates: scoring it would read as a miss on the ' +
      'buggy build and as a clean pass on the clean one, which is the same non-answer with opposite ' +
      'signs. A high count there is itself a cost of the tool.',
  );
  L.push('');
  L.push(
    'A **void run** is a cell where every tool call was refused for want of a session. It is neither a ' +
      'detection nor a false positive: the model was asked to verify and shown nothing. Any value other ' +
      'than 0 invalidates that column, and the preflight check is there to stop a run before it happens.',
  );
  return L.join('\n') + '\n';
}

(async () => {
  const _ids = (process.env.BENCH_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bugs = _ids.length ? BUGS.filter((b) => _ids.includes(b.id)) : BUGS.slice(0, argLimit());
  const procs = await ensureApp(RETICLE_PORT);
  await sleep(1000);
  await preflightReticle(bugUrl(''));
  console.log(`preflight ok — reticle sees the app on ${RETICLE_PORT}`);
  const rows = [];
  for (const bug of bugs) {
    for (const variant of ['buggy', 'clean']) {
      for (const tool of TOOLS) {
        const row = await runCell(bug, tool, variant);
        rows.push(row);
        console.log(
          JSON.stringify({
            bug: row.bug,
            tool: row.tool,
            v: row.variant,
            tot: row.total_tokens,
            turns: row.turns,
            holds: row.verdict_holds,
            det: row.detected,
            $: row.cost_usd.toFixed(4),
          }),
        );
      }
    }
  }
  // A run where no cell ever reached a verdict (bad key, dead provider, every call erroring) still
  // aggregates cleanly into a scorecard full of 0/N and $0.00, which reads as a measured result.
  // Refuse to write one, for the same reason preflight refuses to start one.
  if (rows.every((r) => r.verdict_holds === null)) {
    console.error(
      `REFUSING TO WRITE: all ${rows.length} cells ended without a verdict — nothing was measured.\n` +
        `First evidence: ${rows[0]?.evidence ?? '(none)'}`,
    );
    process.exit(1);
  }
  const voids = rows.filter((r) => r.observed === false);
  if (voids.length > 0) {
    console.error(
      `WARNING: ${voids.length} void cell(s) observed nothing; those columns are not a measurement.`,
    );
  }
  const agg = aggregate(rows);
  writeFileSync(
    path.join(__dirname, 'results-mcp.json'),
    JSON.stringify({ rows, agg, price: PRICE }, null, 2),
  );
  const md = scorecard(agg, rows);
  writeFileSync(path.join(__dirname, 'SCORECARD-MCP.md'), md);
  console.log('\n' + md);
  console.table(agg);
  for (const p of procs) {
    try {
      process.kill(-p.pid);
    } catch {
      /* */
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('HEAD-TO-HEAD ERROR', e);
  process.exit(1);
});
