// Layer B (OpenAI): REAL full agent-loop, authoritative token usage.
//
// For each (scenario, tool): spawn the tool's MCP server, expose its tools to a real OpenAI model
// via the chat-completions tool-use loop, give the canonical NL task, let the MODEL choose calls
// until it emits a verdict, and record usage.prompt_tokens / completion_tokens summed across turns
// (authoritative) + latency + whether the verdict matches expectation.
//
// REQUIRES: OPENAI_API_KEY in env. Without it, prints NOT MEASURED and exits 0 — never fabricates.
//   OPENAI_API_KEY=sk-... node bench/harness/openai-agent-loop.mjs [scenarioId]
import { writeFileSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { inject, revert, revertAll } from './inject.mjs';

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.BENCH_OPENAI_MODEL ?? 'gpt-4o';
const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? 14);

if (!KEY) {
  console.log(
    JSON.stringify({ layer: 'B', status: 'NOT MEASURED', reason: 'OPENAI_API_KEY not set' }),
  );
  process.exit(0);
}

const SERVERS = {
  playwright_mcp: {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated'],
    env: {},
  },
  chrome_devtools_mcp: {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.3.0', '--headless', '--isolated'],
    env: {},
  },
  reticle: {
    command: 'node',
    args: ['packages/server/dist/cli.js', 'mcp', '--port', '4455', '--drive', URL],
    env: {
      RETICLE_PORT: '4455',
      RETICLE_TOOL_PROFILE: process.env.BENCH_RETICLE_PROFILE ?? 'full',
    },
  },
};
// BENCH_TOOLS=reticle,playwright_mcp limits which tools run (cost control). Default: all three.
const TOOL_SET = (
  process.env.BENCH_TOOLS
    ? process.env.BENCH_TOOLS.split(',')
    : ['playwright_mcp', 'chrome_devtools_mcp', 'reticle']
).map((s) => s.trim());

// Canonical NL task per scenario (verbatim across tools) + expected verdict.
const TASKS = {
  'hidden-api-500': {
    regression: null,
    expectIssue: true,
    task: `Open ${URL}, log in with admin@reticle.dev / password, go to the Diagnostics page and click the "500 Server Error" fault button. Then determine whether the app made any failing network request. End your final message with exactly "VERDICT: PASS" (healthy) or "VERDICT: FAIL" (a request failed).`,
  },
  'console-error-intact-ui': {
    regression: null,
    expectIssue: true,
    task: `Open ${URL}, log in with admin@reticle.dev / password, go to Diagnostics and click the buggy chart widget. Determine whether the application logged any error. End with exactly "VERDICT: PASS" (healthy) or "VERDICT: FAIL" (an error was logged).`,
  },
  'route-transition-break': {
    regression: 'route-transition-break',
    expectIssue: true,
    task: `Open ${URL}, log in (admin@reticle.dev / password), then click the "Compose" navigation item. Verify the Compose view actually renders (it has a prompt box and a Generate button). End with exactly "VERDICT: PASS" if it renders, "VERDICT: FAIL" if navigation did nothing.`,
  },
  'missing-modal': {
    regression: 'missing-modal',
    expectIssue: true,
    task: `Open ${URL}, log in (admin@reticle.dev / password), go to Deployments and click "New deployment". Verify the new-deployment modal opens. End with exactly "VERDICT: PASS" if it opens, "VERDICT: FAIL" if no modal appears.`,
  },
  'no-regression-control': {
    regression: null,
    expectIssue: false,
    task: `Open ${URL}, log in (admin@reticle.dev / password), and verify the Overview page is healthy (KPI cards + traffic chart render, no errors). End with exactly "VERDICT: PASS" if healthy, "VERDICT: FAIL" if anything is broken.`,
  },
};

function mcpToolsToOpenAI(tools) {
  return tools.map((t) => {
    const schema =
      t.inputSchema && t.inputSchema.type === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: t.name,
        description: (t.description ?? '').slice(0, 1000),
        parameters: schema,
      },
    };
  });
}

async function callOpenAI(messages, tools) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', max_tokens: 1024 }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function runCell(scenarioId, toolKey) {
  const sc = TASKS[scenarioId];
  const cfg = SERVERS[toolKey];
  const client = new McpStdioClient(cfg.command, cfg.args, cfg.env);
  const t0 = Date.now();
  const trace = [];
  let inTok = 0,
    outTok = 0,
    turns = 0,
    verdictText = '';
  try {
    await client.start();
    if (toolKey === 'reticle') await new Promise((r) => setTimeout(r, 3500));
    const tools = mcpToolsToOpenAI(await client.listTools());
    const messages = [
      {
        role: 'system',
        content:
          'You are a browser verification agent. Use the provided tools to complete the task, then end your final message with exactly "VERDICT: PASS" or "VERDICT: FAIL".',
      },
      { role: 'user', content: sc.task },
    ];
    for (turns = 0; turns < MAX_TURNS; turns++) {
      const resp = await callOpenAI(messages, tools);
      inTok += resp.usage?.prompt_tokens ?? 0;
      outTok += resp.usage?.completion_tokens ?? 0;
      const msg = resp.choices?.[0]?.message;
      if (!msg) break;
      messages.push(msg);
      if (typeof msg.content === 'string' && msg.content) verdictText += '\n' + msg.content;
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) break;
      for (const tc of calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* */
        }
        let content = '';
        try {
          const out = await client.callTool(tc.function.name, args, 60000);
          content = out.text.slice(0, 8000);
        } catch (e) {
          content = `error: ${String(e).slice(0, 200)}`;
        }
        if (process.env.BENCH_TRACE)
          trace.push({ turn: turns, call: tc.function.name, resultChars: content.length });
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
    }
    const said = /VERDICT:\s*FAIL/i.test(verdictText)
      ? true
      : /VERDICT:\s*PASS/i.test(verdictText)
        ? false
        : null;
    return {
      scenario: scenarioId,
      tool: toolKey,
      layer: 'B',
      model: MODEL,
      token_input: inTok,
      token_output: outTok,
      total_tokens: inTok + outTok,
      latency_ms: Date.now() - t0,
      turns,
      verdict: said === null ? 'NO VERDICT' : said ? 'ISSUE DETECTED' : 'NO ISSUE FOUND',
      detected_issue: said,
      expected_detect: sc.expectIssue,
      confidence: said === sc.expectIssue ? 1 : 0,
      notes: `verdict_excerpt=${verdictText.trim().slice(-140)}`,
      ...(process.env.BENCH_TRACE ? { trace, verdictFull: verdictText.trim().slice(-600) } : {}),
    };
  } catch (e) {
    return {
      scenario: scenarioId,
      tool: toolKey,
      layer: 'B',
      verdict: 'NOT MEASURED',
      notes: `error: ${String(e).slice(0, 200)}`,
    };
  } finally {
    await client.stop();
    if (toolKey === 'reticle') {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('node', ['packages/server/dist/cli.js', 'stop', '--port', '4455', '--quiet'], {
          stdio: 'ignore',
        });
      } catch {
        /* */
      }
    }
  }
}

const only = process.argv[2];
const scns = only ? [only] : Object.keys(TASKS);
const rows = [];
for (const s of scns) {
  const reg = TASKS[s].regression;
  if (reg) {
    inject(reg);
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const tool of TOOL_SET) {
    const row = await runCell(s, tool);
    rows.push(row);
    console.log(
      JSON.stringify({
        s: row.scenario,
        t: row.tool,
        in: row.token_input,
        out: row.token_output,
        tot: row.total_tokens,
        turns: row.turns,
        det: row.detected_issue,
        exp: row.expected_detect,
        v: row.verdict,
      }),
    );
  }
  if (reg) revert(reg);
}
revertAll();
writeFileSync('bench/raw/agent-loop-openai.json', JSON.stringify(rows, null, 2));
console.log(`\nwrote ${rows.length} Layer B rows (model=${MODEL})`);
process.exit(0);
