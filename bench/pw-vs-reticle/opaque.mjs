// Metric #7 — opaque React shells. Runs a sample in ?opaque=2 (data-testid + role + aria all
// stripped; only text + Reticle's dev-only source stamps remain) and measures whether each tool
// can still DETECT the bug. Reticle: state bugs via reticle_state (zero DOM anchor); DOM bugs via
// text/source. Playwright: text only (getByText) — its testid/role selectors are gone.
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { McpStdioClient } from '../harness/mcp-client.mjs';
import { ensureApp } from './run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'packages', 'core', 'dist', 'cli.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = 'http://localhost:4312';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (t) => { try { return JSON.parse(t); } catch { return t; } };
const url = (id) => `${ORIGIN}/?opaque=2${id ? `&reticle-bug=${id}` : ''}`;

// Sample: 2 DOM bugs (text survives → both should still manage) + 2 state bugs (reticle-only).
const SAMPLE = [
  { id: 'invisible', kind: 'usable', text: 'New deploy', nav: 'Deployments', expect: 'both' },
  { id: 'console-leak', kind: 'console', text: 'Generate', nav: 'Compose', expect: 'both' },
  { id: 'mutation-leak', kind: 'state', statePath: 'deployments.0.status', text: 'Generate', nav: 'Compose', expect: 'reticle-only' },
  { id: 'kpi-deploys-tamper', kind: 'state', statePath: 'deployments.0.service', text: 'Generate', nav: 'Compose', expect: 'reticle-only' },
];

async function reticleRun() {
  const c = new McpStdioClient('node', [CLI, 'mcp', '--port', '4460'], { RETICLE_PORT: '4460', RETICLE_TOOL_PROFILE: 'full' });
  await c.start();
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(os.tmpdir(), 'opq-' + process.pid)}`, ORIGIN], { stdio: 'ignore', detached: true });
  chrome.unref();
  const call = async (n, a) => P((await c.callTool(n, a)).text);
  let sid;
  for (let i = 0; i < 40 && !sid; i++) { sid = (await call('reticle_sessions', {}))?.sessions?.[0]?.sessionId; if (!sid) await sleep(500); }
  const goto = async (u) => { await call('reticle_navigate', { sessionId: sid, url: u }); for (let i = 0; i < 30; i++) { const s = await call('reticle_sessions', {}); const f = (s?.sessions ?? []).find((x) => x.url === u) ?? s?.sessions?.[0]; if (f) { sid = f.sessionId; if (i > 1) break; } await sleep(300); } await sleep(500); };
  // find by visible text (testid+role are stripped in opaque=2) → returns a ref
  const byText = async (t) => (await call('reticle_query', { sessionId: sid, by: 'text', value: t }))?.elements?.[0]?.ref;
  const clickText = async (t) => { const r = await byText(t); if (r) await call('reticle_act', { sessionId: sid, ref: r, action: 'click', args: { confirmDangerous: true } }); await sleep(300); return r; };
  const out = [];
  for (const b of SAMPLE) {
    let caught = false, note = '';
    try {
      await goto(url(b.id));
      await clickText('Sign in'); await sleep(400);
      if (b.nav) await clickText(b.nav);
      if (b.kind === 'usable') {
        const ref = await byText(b.text);
        const ins = ref ? await call('reticle_inspect', { sessionId: sid, ref }) : null;
        caught = !!ins && (ins.styles?.opacity === '0' || ins.occluded === true || (ins.box && (ins.box.width === 0 || ins.box.height === 0)));
        note = ins ? `opacity=${ins.styles?.opacity} occluded=${ins.occluded}` : 'not found by text';
      } else if (b.kind === 'console') {
        const act = await (async () => { const r = await byText('benchmark note'); return r; })(); // fill prompt: opaque strips testid, fill by nearest textbox
        // find the prompt textbox by role is gone; fill first textarea via act on a text anchor isn't reliable — use state-independent trigger
        const ref = await byText(b.text);
        const a0 = ref ? await call('reticle_act', { sessionId: sid, ref, action: 'click', args: { confirmDangerous: true } }) : {};
        await sleep(400);
        const con = await call('reticle_console', { sessionId: sid, level: 'error', since: a0?.since });
        caught = (con?.logs ?? []).length > 0; note = `errors=${(con?.logs ?? []).length}`;
      } else if (b.kind === 'state') {
        const pre = await call('reticle_state', { sessionId: sid, store: 'app', path: b.statePath, depth: 8 });
        await clickText(b.text);
        const post = await call('reticle_state', { sessionId: sid, store: 'app', path: b.statePath, depth: 8 });
        caught = JSON.stringify(pre?.value) !== JSON.stringify(post?.value);
        note = `state ${JSON.stringify(pre?.value)}→${JSON.stringify(post?.value)}`;
      }
    } catch (e) { note = 'ERR ' + e.message; }
    out.push({ tool: 'reticle', bug: b.id, expect: b.expect, caught, note });
  }
  try { await c.stop(); } catch {}
  try { process.kill(-chrome.pid); } catch {}
  return out;
}

async function playwrightRun() {
  const browser = await chromium.launch();
  const out = [];
  for (const b of SAMPLE) {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errs = []; page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    let caught = false, note = '';
    try {
      await page.goto(url(b.id), { waitUntil: 'domcontentloaded' }); await sleep(700);
      await page.getByText('Sign in', { exact: false }).first().click({ force: true }).catch(() => {}); await sleep(600);
      if (b.nav) await page.getByText(b.nav, { exact: false }).first().click({ force: true }).catch(() => {}); await sleep(400);
      if (b.kind === 'usable') {
        const loc = page.getByText(b.text, { exact: false }).first();
        const info = await loc.evaluate((el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { opacity: s.opacity, occluded: top !== el && !el.contains(top), w: r.width, h: r.height }; }).catch(() => null);
        caught = !!info && (info.opacity === '0' || info.occluded || info.w === 0 || info.h === 0);
        note = info ? `opacity=${info.opacity} occluded=${info.occluded}` : 'not found by text';
      } else if (b.kind === 'console') {
        errs.length = 0;
        await page.getByText(b.text, { exact: false }).first().click({ force: true }).catch(() => {}); await sleep(500);
        caught = errs.length > 0; note = `errors=${errs.length}`;
      } else if (b.kind === 'state') {
        await page.getByText(b.text, { exact: false }).first().click({ force: true }).catch(() => {}); await sleep(400);
        caught = false; note = 'no app-state access — store invariant unreadable from an opaque DOM';
      }
    } catch (e) { note = 'ERR ' + e.message; }
    await ctx.close().catch(() => {});
    out.push({ tool: 'playwright', bug: b.id, expect: b.expect, caught, note });
  }
  await browser.close();
  return out;
}

(async () => {
  await ensureApp(); await sleep(1000);
  console.log('opaque=2 — reticle…'); const r = await reticleRun();
  console.log('opaque=2 — playwright…'); const p = await playwrightRun();
  const rows = [...r, ...p];
  writeFileSync(path.join(__dirname, 'results-opaque.json'), JSON.stringify({ rows }, null, 2));
  console.log('\n| Bug | expect | Reticle (opaque) | Playwright (opaque) |');
  console.log('|---|---|:--:|:--:|');
  for (const b of SAMPLE) {
    const rr = r.find((x) => x.bug === b.id), pp = p.find((x) => x.bug === b.id);
    console.log(`| ${b.id} | ${b.expect} | ${rr.caught ? '✅' : '⬜'} ${rr.note.slice(0, 30)} | ${pp.caught ? '✅' : '⬜'} ${pp.note.slice(0, 30)} |`);
  }
  process.exit(0);
})().catch((e) => { console.error('OPAQUE ERR', e); process.exit(1); });
