/**
 * The LIVE QA agent — a real LLM tool-calling loop (vs the scripted driver in verify-live.mjs).
 * An API agent is given the Reticle tools as functions and asked to verify the generated app; it decides
 * which tools to call, reasons over the program-truth it observes, and reports a verdict. This is the
 * autonomous analogue of the builder's QA agent — it runs server-side, in-process, against a real
 * headless sandbox, and reaches Reticle's tools directly (no MCP stdio, no human).
 *
 * Provider-portable: any OpenAI-compatible chat-completions endpoint works via env vars.
 *   LLM_BASE_URL  (default https://api.moonshot.ai/v1  — Kimi / Moonshot)
 *   LLM_MODEL     (default kimi-k2-0711-preview)
 *   LLM_API_KEY   (required — NEVER commit this; pass it in the environment)
 *
 *   LLM_API_KEY=sk-... PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 BUG=mock-data \
 *     node qa/qa-agent-live.mjs
 */
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  AnnotationStore,
  ProjectStore,
  createNodeFileSystem,
  LaunchedRealInputProvider,
} from '@reticlehq/server';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pull the expenses array out of whatever shape reticle_state returns. */
function findExpenses(state) {
  const seen = new Set();
  const walk = (v) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v.expenses)) return v.expenses;
    for (const key of Object.keys(v)) {
      const found = walk(v[key]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(state);
}

/** Minimal .env loader (no dep): reads apps/vibe-builder-demo/.env into process.env without overwriting. */
function loadDotEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env — rely on the ambient environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.moonshot.ai/v1';
const MODEL = process.env.LLM_MODEL ?? 'kimi-k2-0711-preview';
const API_KEY = process.env.LLM_API_KEY ?? process.env.KIMI_API_KEY ?? '';

// ── The Reticle tools we expose to the LLM (testid-oriented — refs are resolved internally so the
//    model never handles or invents them). Results are shaped small so the model reasons cleanly. ──
const LLM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'act',
      description:
        'Act on an element identified by its testid (NOT a ref). action is "fill" | "click" | "clear". For "fill" also pass value. Example: act(testid="amount", action="fill", value="42").',
      parameters: {
        type: 'object',
        properties: {
          testid: { type: 'string', description: 'The data-testid of the element, e.g. "amount" or "add".' },
          action: { type: 'string', enum: ['fill', 'click', 'clear'] },
          value: { type: 'string' },
        },
        required: ['testid', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_network',
      description: 'Return the POST calls observed to /api/expenses so far: a list of { method, url, status } and a count. Use to verify the write fired exactly once and returned 200.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_console',
      description: 'Return console errors observed so far: { errorCount, messages }. Use to detect silent console errors.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_state',
      description: 'Read the live app store (program truth): returns { expenseCount, total }. The source of truth a screenshot cannot reach.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_verdict',
      description: 'Finish the verification. status="pass" if the app behaves correctly, "fail" if any silent failure was found.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pass', 'fail'] },
          summary: { type: 'string' },
          failures: { type: 'array', items: { type: 'string' } },
        },
        required: ['status', 'summary'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are an autonomous QA agent verifying a freshly generated web app: an Expense Tracker.
You can observe the running app via tools — the network calls, the console, and the app's store (program truth). You do NOT see screenshots; you reason over structured facts.

The app has these testids: "amount" (the amount input), "add" (the Add button), "total" (the displayed total), "del" (a delete button). You act on elements by their TESTID — you never deal with refs.

Your job: drive the "add expense" flow and decide if the app is correct, catching SILENT failures (the page renders and requests return 200, but something is wrong underneath):
- the POST succeeds but the store never persists the expense (mock data)
- the Add button fires the POST more than once (double submit)
- a console error is logged even though the UI renders
- the displayed total disagrees with the store's true total
- invalid input is accepted

Procedure (be efficient — one pass):
1. act(testid="amount", action="fill", value="42")
2. act(testid="add", action="click")
3. check_network — POST /api/expenses should appear EXACTLY once with status 200.
4. check_state — expenseCount should be exactly 1, and total should be 42.
5. check_console — there should be zero errors.
6. Call report_verdict. status="pass" ONLY if all of the above hold; otherwise status="fail" and list the specific failures you observed (cite the numbers).
Always finish by calling report_verdict. Trust the tool results over your expectations.`;

async function chat(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: LLM_TOOLS, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function runLiveAgent({ bug = 'none', previewUrl = 'http://localhost:4318', bridgePort = 4422, headless = true, log = () => {} } = {}) {
  if (API_KEY === '') throw new Error('LLM_API_KEY is not set — pass it in the environment');
  const startedAt = Date.now();
  await fetch(`${previewUrl}/api/reset`, { method: 'DELETE', headers: { 'x-bug': bug } });

  const server = await start({ port: bridgePort, mcp: false });
  const provider = new LaunchedRealInputProvider({ driveUrl: `${previewUrl}/?bug=${bug}&reticle=1`, headless });
  await provider.navigate();
  const fs = createNodeFileSystem();
  const reticleRoot = mkdtempSync(join(tmpdir(), 'reticle-live-'));
  const now = () => Date.now();
  const deps = {
    sessions: server.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    annotations: new AnnotationStore(),
    flows: new FlowStore(fs, reticleRoot, { now }),
    project: new ProjectStore(fs, reticleRoot, { now }),
    fs,
    reticleRoot,
    now,
    realInput: provider,
  };
  const callReticle = (name, args) => TOOLS.find((t) => t.name === name).handler(deps, { sessionId: 'preview', ...args });

  // Resolve a testid → ref internally so the LLM never handles refs (the source of hallucinated refs).
  const refFor = async (testid) => {
    const r = await callReticle('reticle_query', { by: 'testid', value: testid });
    return r.elements?.[0]?.ref;
  };

  /** Dispatch an LLM tool call to Reticle and return a SMALL, unambiguous result the model can reason over. */
  async function dispatch(name, args) {
    if (name === 'act') {
      const ref = await refFor(args.testid);
      if (ref === undefined) return { ok: false, error: `no element with testid "${args.testid}"` };
      if (args.action === 'click') {
        await callReticle('reticle_act_and_wait', { ref, action: 'click' });
        await sleep(350);
        return { ok: true, acted: `click ${args.testid}` };
      }
      await callReticle('reticle_act', { ref, action: args.action, args: args.value !== undefined ? { value: args.value } : {} });
      return { ok: true, acted: `${args.action} ${args.testid}${args.value !== undefined ? `="${args.value}"` : ''}` };
    }
    if (name === 'check_network') {
      const net = await callReticle('reticle_network', { method: 'POST', urlContains: '/api/expenses' });
      const calls = net.calls ?? net.requests ?? net.network ?? [];
      return {
        postCount: Array.isArray(calls) ? calls.length : 0,
        calls: (Array.isArray(calls) ? calls : []).map((c) => ({ method: c.method, url: c.url, status: c.status })),
      };
    }
    if (name === 'check_console') {
      const con = await callReticle('reticle_console', { level: 'error' });
      const list = con.entries ?? con.logs ?? con.console ?? [];
      return { errorCount: Array.isArray(list) ? list.length : 0, messages: (Array.isArray(list) ? list : []).map((e) => e.text ?? e.message ?? String(e)).slice(0, 5) };
    }
    if (name === 'check_state') {
      const st = await callReticle('reticle_state', { store: 'app' });
      const expenses = findExpenses(st) ?? [];
      const total = expenses.reduce((s, e) => s + (Number.isNaN(e.amount) ? 0 : e.amount), 0);
      return { expenseCount: expenses.length, total };
    }
    return { error: `unknown tool ${name}` };
  }

  try {
    for (let i = 0; i < 100 && server.bridge.sessions.count() === 0; i++) await sleep(50);
    if (server.bridge.sessions.count() === 0) throw new Error('sandbox SDK never connected');
    await callReticle('reticle_wait_ready', { timeoutMs: 10000 });

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Verify this build (internal label: "${bug}"). Begin.` },
    ];
    const trace = [];
    for (let step = 0; step < 14; step++) {
      const data = await chat(messages);
      const msg = data.choices?.[0]?.message;
      if (msg === undefined) throw new Error('no message from LLM');
      messages.push(msg);
      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // Model spoke without a tool call — nudge it to finish.
        messages.push({ role: 'user', content: 'Call report_verdict to finish.' });
        continue;
      }
      for (const tc of toolCalls) {
        const name = tc.function.name;
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch { /* leave empty */ }
        if (name === 'report_verdict') {
          const verdict = { bug, status: args.status, summary: args.summary, failures: args.failures ?? [], steps: trace.length, durationMs: Date.now() - startedAt, model: MODEL };
          log(`report_verdict: ${args.status} — ${args.summary}`);
          return verdict;
        }
        let result;
        try {
          result = await dispatch(name, args);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        trace.push({ name, args });
        log(`→ ${name}(${JSON.stringify(args)})`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
      }
    }
    return { bug, status: 'inconclusive', summary: 'agent did not report a verdict within the step budget', failures: [], steps: trace.length, durationMs: Date.now() - startedAt, model: MODEL };
  } finally {
    await provider.dispose();
    await server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bug = process.env.BUG ?? 'mock-data';
  runLiveAgent({
    bug,
    previewUrl: process.env.PREVIEW_URL ?? 'http://localhost:4318',
    bridgePort: Number(process.env.BRIDGE_PORT ?? 4422),
    log: (m) => console.log('  ' + m),
  })
    .then((v) => {
      console.log(`\n=== LIVE agent verdict for BUG=${bug} (${v.model}) ===`);
      console.log(`  status: ${String(v.status).toUpperCase()}  ·  ${v.steps} tool calls  ·  ${v.durationMs}ms`);
      console.log(`  ${v.summary}`);
      for (const f of v.failures) console.log(`   ✗ ${f}`);
      process.exit(v.status === 'fail' || (v.status === 'pass' && bug === 'none') ? 0 : 1);
    })
    .catch((err) => {
      console.error('live agent error:', err.message ?? err);
      process.exit(2);
    });
}
