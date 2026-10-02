// What delegating the drive costs, versus driving it yourself.
//
// The claim under test is about WHOSE context pays. An agent that drives an app through the tool
// surface pays for every snapshot, act result and observation in its own transcript, and pays for
// them again on every subsequent turn — measured elsewhere in this directory at tens of thousands of
// tokens per verification, every run. `reticle_verify { action: "explore" }` moves that drive into
// the daemon: a small model drives the same tools, records what it drove as saved flows, and the
// agent reads a few lines back.
//
// Two arms, same app, same MCP server, same model:
//
//   drive     the agent drives the app itself, as it does today
//   delegate  the agent calls reticle_verify { action: "explore" }, then replays what it saved
//
// The comparable column is `agent_total_tokens` — what the CALLER paid. `daemon_tokens` is what the
// drive cost inside the daemon, reported by the tool itself, and it is NOT free: it is a cheaper
// model against a cached prefix, and a run that ignores it is quoting half a price.
//
// REQUIRES: ANTHROPIC_API_KEY, and `pnpm --filter @reticlehq/bench-app dev` (or any app) on BENCH_URL.
// Without a key this prints NOT MEASURED and exits 0 — it never fabricates a number.
//
//   ANTHROPIC_API_KEY=sk-... node bench/harness/explore-cost.mjs
//
import { writeFileSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { RETICLE_PORT } from './ports.mjs';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BENCH_MODEL ?? 'claude-haiku-4-5-20251001';
const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? 25);
const OUT = 'bench/raw/explore-cost.json';

if (!KEY) {
  console.log(
    JSON.stringify(
      {
        arm: 'explore-cost',
        status: 'NOT MEASURED',
        reason:
          'ANTHROPIC_API_KEY not set. Both arms put a real model in the loop, so neither can be measured without it. Set the key and re-run; every token comes straight from the API usage object.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const TASK =
  `Verify that the app at ${URL} actually works for a user: log in with admin@reticle.dev / password, ` +
  `move through the product the way somebody using it would, and find out whether what it shows is ` +
  `backed by what it does. End your final message with exactly "VERDICT: PASS" or "VERDICT: FAIL".`;

const ARMS = {
  drive: '',
  delegate:
    '\n\nDo NOT drive the app yourself. Call reticle_verify { action: "explore", persona: "<who to be>" } ' +
    'once — a model inside the daemon drives it for you and records what it drove — and then ' +
    'reticle_verify { action: "flows" } to replay what was recorded. Decide your verdict from those two answers.',
};

const CACHE_CONTROL = { type: 'ephemeral' };

function toAnthropicTools(tools) {
  return tools.map((t, i) => ({
    name: t.name,
    description: (t.description ?? '').slice(0, 900),
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    ...(i === tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
  }));
}

async function callAnthropic(messages, tools, system) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: system, cache_control: CACHE_CONTROL }],
      tools,
      messages,
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/** What the daemon spent, read out of the explore tool's own answer rather than guessed at. */
function daemonUsage(text) {
  try {
    const parsed = JSON.parse(text);
    const usage = parsed?.usage;
    if (!usage) return null;
    return {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      savedFlows: parsed.savedFlows ?? [],
      steps: parsed.steps ?? 0,
    };
  } catch {
    return null;
  }
}

async function runArm(arm) {
  const client = new McpStdioClient(
    'node',
    ['server/dist/command/cli.js', 'mcp', '--port', RETICLE_PORT, '--drive', URL],
    { RETICLE_PORT },
  );
  const t0 = Date.now();
  let inTok = 0,
    cacheWriteTok = 0,
    cacheReadTok = 0,
    outTok = 0,
    turns = 0,
    resultBytes = 0,
    verdictText = '';
  const toolCalls = [];
  let daemon = null;
  try {
    const init = await client.start();
    await new Promise((r) => setTimeout(r, 3500));
    const tools = toAnthropicTools(await client.listTools());
    const instructions =
      'string' === typeof init?.instructions && '' !== init.instructions
        ? `\n\nThe tool server you are connected to provides these instructions:\n${init.instructions}`
        : '';
    const system =
      'You are a verification agent with browser tools. Use them to complete the task, then end your final message with exactly "VERDICT: PASS" or "VERDICT: FAIL".' +
      instructions +
      ARMS[arm];
    const messages = [{ role: 'user', content: TASK }];
    for (turns = 0; turns < MAX_TURNS; turns++) {
      const resp = await callAnthropic(messages, tools, system);
      inTok += resp.usage?.input_tokens ?? 0;
      cacheWriteTok += resp.usage?.cache_creation_input_tokens ?? 0;
      cacheReadTok += resp.usage?.cache_read_input_tokens ?? 0;
      outTok += resp.usage?.output_tokens ?? 0;
      messages.push({ role: 'assistant', content: resp.content });
      const uses = resp.content.filter((c) => 'tool_use' === c.type);
      const text = resp.content
        .filter((c) => 'text' === c.type)
        .map((c) => c.text)
        .join('\n');
      if (text) verdictText += '\n' + text;
      if (resp.stop_reason !== 'tool_use' || 0 === uses.length) break;
      const results = [];
      for (const use of uses) {
        try {
          toolCalls.push(use.name);
          // The drive is a long call by design: a model driving an app is dozens of its own turns.
          const out = await client.callTool(use.name, use.input, 900_000);
          const sent = out.text.slice(0, 8000);
          resultBytes += Buffer.byteLength(sent, 'utf8');
          daemon = daemonUsage(out.text) ?? daemon;
          results.push({ type: 'tool_result', tool_use_id: use.id, content: sent });
        } catch (e) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `error: ${String(e).slice(0, 200)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    const said = /VERDICT:\s*FAIL/i.test(verdictText)
      ? 'fail'
      : /VERDICT:\s*PASS/i.test(verdictText)
        ? 'pass'
        : null;
    return {
      arm,
      model: MODEL,
      turns,
      // A cell cut off by the budget decided nothing, and reporting it beside one that did would be
      // the same collapse the agent-loop arm had to be corrected for.
      exhausted: turns >= MAX_TURNS,
      verdict: said,
      agent_token_input: inTok + cacheWriteTok + cacheReadTok,
      agent_token_cache_read: cacheReadTok,
      agent_token_output: outTok,
      agent_total_tokens: inTok + cacheWriteTok + cacheReadTok + outTok,
      agent_result_bytes: resultBytes,
      tool_calls: toolCalls,
      // Null on the drive arm, where no drive was delegated. Never zero: zero would read as free.
      daemon_tokens: daemon,
      wall_ms: Date.now() - t0,
    };
  } finally {
    await client.stop?.();
  }
}

const rows = [];
for (const arm of Object.keys(ARMS)) {
  try {
    rows.push(await runArm(arm));
  } catch (error) {
    rows.push({ arm, status: 'ERROR', error: String(error).slice(0, 400) });
  }
}

const drive = rows.find((r) => 'drive' === r.arm);
const delegate = rows.find((r) => 'delegate' === r.arm);
const ratio =
  drive?.agent_total_tokens && delegate?.agent_total_tokens
    ? Number((drive.agent_total_tokens / delegate.agent_total_tokens).toFixed(1))
    : null;

const report = {
  arm: 'explore-cost',
  url: URL,
  rows,
  // The headline, and exactly what it is a ratio OF: tokens in the CALLING agent's context for one
  // verification. It is not a wall-clock number and it is not the whole model bill — `daemon_tokens`
  // is the other half, and a quote that drops it is dishonest.
  agent_context_ratio: ratio,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
