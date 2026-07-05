// Reticle-SCRIPT harness: a deterministic Node script that drives the Reticle MCP tools (no LLM)
// to verify each bug's intent. Measures observation cost (bytes of tool output consumed), latency,
// and whether the check correctly caught the bug. Mirrors what an agent would do, minus the model.
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../harness/mcp-client.mjs';
import { APP_ORIGIN, bugUrl } from './bugs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'packages', 'core', 'dist', 'cli.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.BENCH_RETICLE_PORT ?? '4460';

const parseText = (t) => { try { return JSON.parse(t); } catch { return t; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runReticle(bugs) {
  const client = new McpStdioClient(
    'node', [CLI, 'mcp', '--port', PORT],
    { RETICLE_PORT: PORT, RETICLE_TOOL_PROFILE: 'full' },
  );
  await client.start();

  // one headless Chrome; we reticle_navigate it to each bug URL (fresh SDK session per load).
  const profile = path.join(os.tmpdir(), `rbench-${process.pid}`);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, APP_ORIGIN], { stdio: 'ignore', detached: true });
  chrome.unref();

  let bytes = 0;
  const call = async (name, args) => {
    const { text } = await client.callTool(name, args);
    bytes += (text ?? '').length;
    return parseText(text ?? '');
  };

  // wait for the first session
  let sid;
  for (let i = 0; i < 40 && !sid; i++) {
    const s = await call('reticle_sessions', {});
    sid = s?.sessions?.[0]?.sessionId;
    if (!sid) await sleep(500);
  }

  // navigate to a URL and return the fresh focused session id
  const goto = async (url) => {
    await call('reticle_navigate', { sessionId: sid, url });
    for (let i = 0; i < 30; i++) {
      const s = await call('reticle_sessions', {});
      const focused = (s?.sessions ?? []).find((x) => x.url === url && !x.throttled) ?? (s?.sessions ?? [])[0];
      if (focused) { sid = focused.sessionId; if (i > 1) break; }
      await sleep(300);
    }
    await sleep(400); // let the app render + SDK register capabilities
  };

  const refOf = async (testid) => {
    const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: testid });
    return q?.elements?.[0]?.ref;
  };
  // Post-login/nav renders are async; poll until the testid resolves (or timeout) before acting.
  const waitRef = async (testid, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ref = await refOf(testid);
      if (ref) return ref;
      if (Date.now() >= deadline) return undefined;
      await sleep(150);
    }
  };
  const doPrep = async (prep) => {
    if (!prep?.fill) return;
    const ref = await waitRef(prep.fill);
    if (ref) { await call('reticle_act', { sessionId: sid, ref, action: 'fill', args: { value: prep.text } }); await sleep(200); }
  };
  const clickSteps = async (steps) => {
    for (const t of steps) {
      const ref = await waitRef(t);
      if (ref) await call('reticle_act', { sessionId: sid, ref, action: 'click' });
      await sleep(250);
    }
  };

  const results = [];
  for (const bug of bugs) {
    for (const variant of ['clean', 'buggy']) {
      const url = variant === 'buggy' ? bugUrl(bug.id) : bugUrl('');
      const before = bytes;
      const t0 = Date.now();
      let caught = false, note = '';
      try {
        await goto(url);
        await clickSteps(bug.setup);
        const c = bug.check;
        if (c.kind === 'usable') {
          const ref = await waitRef(c.testid);
          const ins = ref ? await call('reticle_inspect', { sessionId: sid, ref }) : null;
          const b = ins?.box; const st = ins?.styles ?? {};
          caught = !ref ? false : ins.occluded === true || (b && (b.width === 0 || b.height === 0)) || st.opacity === '0' || ins.visible === false;
          note = ins ? `occluded=${ins.occluded} box=${b?.width}x${b?.height} opacity=${st.opacity}` : 'element not found';
        } else if (c.kind === 'paint') {
          caught = false; note = 'reticle script has no pixel diff (inspect computed-styles unchanged)';
        } else if (c.kind === 'domCountMatchesState') {
          // truth: the real store array length (depth-0 markers cap the display, so read the array).
          const st = await call('reticle_state', { sessionId: sid, store: 'app', path: c.statePath });
          const v = st?.value;
          const truth = Array.isArray(v) ? v.length : Number((JSON.stringify(v).match(/\d+/) ?? [])[0]);
          // display: read ONLY the snapshot tree text (not JSON metadata) for the badge number.
          const snap = await call('reticle_snapshot', { sessionId: sid, scope: `[data-testid="${c.testid}"]` });
          const domNum = Number((String(snap?.tree ?? '').match(/\d+/g) ?? [])[0]);
          caught = Number.isFinite(truth) && Number.isFinite(domNum) && truth !== domNum;
          note = `storeLen=${truth} badge=${domNum}`;
        } else if (c.kind === 'consoleCleanAfter') {
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref ? await call('reticle_act', { sessionId: sid, ref, action: 'click' }) : {};
          await sleep(400);
          const con = await call('reticle_console', { sessionId: sid, level: 'error', since: act0?.since });
          const errs = (con?.logs ?? []).length;
          caught = ref ? errs > 0 : false;
          note = ref ? `errors=${errs}` : 'compose-generate not reached';
        } else if (c.kind === 'netCountAfter') {
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          const act0 = ref ? await call('reticle_act', { sessionId: sid, ref, action: 'click' }) : {};
          await sleep(600);
          const net = await call('reticle_network', { sessionId: sid, method: c.method, limit: 50 });
          const n = (net?.calls ?? []).filter((e) => String(e.url ?? '').includes(c.urlContains)).length;
          caught = ref ? n !== c.expected : false;
          note = ref ? `count=${n} expected=${c.expected}` : 'compose-generate not reached';
        } else if (c.kind === 'stateInvariantAfter') {
          const pre = await call('reticle_state', { sessionId: sid, store: 'app', path: c.statePath });
          await doPrep(c.prep);
          const ref = await waitRef(c.steps[0]);
          if (ref) await call('reticle_act', { sessionId: sid, ref, action: 'click' });
          await sleep(400);
          const post = await call('reticle_state', { sessionId: sid, store: 'app', path: c.statePath });
          caught = ref ? JSON.stringify(pre?.value) !== JSON.stringify(post?.value) : false;
          note = `before=${JSON.stringify(pre?.value)} after=${JSON.stringify(post?.value)}`;
        }
      } catch (e) { note = `ERR ${e.message}`; }
      results.push({ harness: 'reticle-script', bug: bug.id, category: bug.category, variant, caught, expect: bug.expect, bytes: bytes - before, ms: Date.now() - t0, note });
    }
  }

  try { await client.stop(); } catch {}
  try { process.kill(-chrome.pid); } catch {}
  return results;
}
