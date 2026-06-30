// Layer B: REAL full agent-loop, authoritative token usage.
//
// For each (scenario, tool): spawn the tool's MCP server, expose its tools to a real
// Claude model via the Messages API tool-use loop, give the canonical NL task, let the
// MODEL choose calls until it emits a verdict, and record usage.input_tokens /
// output_tokens summed across turns (the authoritative Anthropic count) + latency +
// whether the verdict matches expectation.
//
// REQUIRES: ANTHROPIC_API_KEY. Without it this prints a clear NOT MEASURED notice and
// exits 0 — it never fabricates numbers. Run AFTER `inject` wiring is in place; this
// reuses adapters' server spawn config + the same scenario definitions as Layer A.
//
//   ANTHROPIC_API_KEY=sk-... node bench/harness/agent-loop.mjs [scenarioId]
//
import { writeFileSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { inject, revert, revertAll } from './inject.mjs';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BENCH_MODEL ?? 'claude-haiku-4-5-20251001';
const URL = 'http://localhost:4312/';
const MAX_TURNS = 12;

if (!KEY) {
  console.log(
    JSON.stringify(
      {
        layer: 'B',
        status: 'NOT MEASURED',
        reason:
          'ANTHROPIC_API_KEY not set. Layer B (agent-reasoning token usage) cannot be measured without it. Set the key and re-run; numbers will come straight from the API usage object.',
      },
      null,
      2,
    ),
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
    env: { RETICLE_PORT: '4455' },
  },
};

// Canonical NL task per scenario (verbatim across tools), plus the expected verdict.
const TASKS = {
  'hidden-api-500': {
    regression: null,
    expectIssue: true,
    task: `Open ${URL}, log in with admin@reticle.dev / password, go to the Diagnostics page and click the "500 Server Error" fault button. Then determine whether the app made any failing network request. Report PASS if everything is healthy or FAIL if a request failed, with the status code.`,
  },
  'console-error-intact-ui': {
    regression: null,
    expectIssue: true,
    task: `Open ${URL}, log in with admin@reticle.dev / password, go to Diagnostics and click the buggy chart widget. Determine whether the application logged any error. Report PASS (healthy) or FAIL (error) and quote the error.`,
  },
  'route-transition-break': {
    regression: 'route-transition-break',
    expectIssue: true,
    task: `Open ${URL}, log in (admin@reticle.dev / password), then click the "Compose" navigation item. Verify the Compose view actually renders (it has a prompt box and a Generate button). Report PASS if it renders, FAIL if navigation did nothing.`,
  },
  'missing-modal': {
    regression: 'missing-modal',
    expectIssue: true,
    task: `Open ${URL}, log in (admin@reticle.dev / password), go to Deployments and click "New deployment". Verify the new-deployment modal opens. Report PASS if it opens, FAIL if no modal appears.`,
  },
  'no-regression-control': {
    regression: null,
    expectIssue: false,
    task: `Open ${URL}, log in (admin@reticle.dev / password), and verify the Overview page is healthy (KPI cards + traffic chart render, no errors). Report PASS if healthy, FAIL if anything is broken.`,
  },
};

function mcpToolsToAnthropic(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description ?? '').slice(0, 900),
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
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
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, tools, messages }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function runCell(scenarioId, toolKey) {
  const sc = TASKS[scenarioId];
  const cfg = SERVERS[toolKey];
  const client = new McpStdioClient(cfg.command, cfg.args, cfg.env);
  const t0 = Date.now();
  let inTok = 0,
    outTok = 0,
    turns = 0,
    verdictText = '';
  try {
    await client.start();
    if (toolKey === 'reticle') await new Promise((r) => setTimeout(r, 3500));
    const tools = mcpToolsToAnthropic(await client.listTools());
    const system =
      'You are a verification agent with browser tools. Use them to complete the task, then end your final message with exactly "VERDICT: PASS" or "VERDICT: FAIL".';
    const messages = [{ role: 'user', content: sc.task }];
    for (turns = 0; turns < MAX_TURNS; turns++) {
      const resp = await callAnthropic(messages, tools, system);
      inTok += resp.usage?.input_tokens ?? 0;
      outTok += resp.usage?.output_tokens ?? 0;
      messages.push({ role: 'assistant', content: resp.content });
      const toolUses = resp.content.filter((c) => c.type === 'tool_use');
      const textParts = resp.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (textParts) verdictText += '\n' + textParts;
      if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) break;
      const results = [];
      for (const tu of toolUses) {
        try {
          const out = await client.callTool(tu.name, tu.input, 60000);
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: out.text.slice(0, 8000),
          });
        } catch (e) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `error: ${String(e).slice(0, 200)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    const said = /VERDICT:\s*FAIL/i.test(verdictText)
      ? true
      : /VERDICT:\s*PASS/i.test(verdictText)
        ? false
        : null;
    const detected = said; // issue detected == verdict FAIL
    return {
      scenario: scenarioId,
      tool: toolKey,
      layer: 'B',
      token_input: inTok,
      token_output: outTok,
      total_tokens: inTok + outTok,
      latency_ms: Date.now() - t0,
      turns,
      verdict: said === null ? 'NO VERDICT' : said ? 'ISSUE DETECTED' : 'NO ISSUE FOUND',
      detected_issue: detected,
      expected_detect: sc.expectIssue,
      confidence: detected === sc.expectIssue ? 1 : 0,
      notes: `model=${MODEL}; turns=${turns}; verdict_excerpt=${verdictText.trim().slice(-160)}`,
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
  for (const tool of ['playwright_mcp', 'chrome_devtools_mcp', 'reticle']) {
    const row = await runCell(s, tool);
    rows.push(row);
    console.log(
      JSON.stringify({
        s: row.scenario,
        t: row.tool,
        in: row.token_input,
        out: row.token_output,
        ms: row.latency_ms,
        v: row.verdict,
      }),
    );
  }
  if (reg) revert(reg);
}
revertAll();
writeFileSync('bench/raw/agent-loop-results.json', JSON.stringify(rows, null, 2));
console.log(`\nwrote ${rows.length} Layer B rows`);
process.exit(0);
