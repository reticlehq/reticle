// Per-tool adapters: login -> navigate -> act -> observe, each call MEASURED.
// Fairness: every adapter pays for a realistic discovery snapshot of the page it
// must act on (an agent can't guess refs/uids), then acts via the most robust
// locator available, then runs the targeted observation. We measure the payloads
// the agent would receive; the physical locator used to drive the click does not
// change those payloads.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpStdioClient } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';

const pexecFile = promisify(execFile);
const LOGIN = { email: 'admin@reticle.dev', password: 'password' };

function rec(call, res) {
  const m = measure(res.text ?? '');
  return {
    call,
    latency_ms: Math.round(res.latencyMs),
    chars: m.chars,
    bytes: m.bytes,
    tokens_o200k: m.tokens_o200k,
    text: res.text ?? '',
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long to wait after spawning the reticle daemon for the driven browser to load + the SDK to connect.
 *  Raise on a slow machine/CI via BENCH_RETICLE_READY_MS. */
const RETICLE_READY_MS = Number(process.env.BENCH_RETICLE_READY_MS ?? '3500');

// ---------- Playwright MCP ----------
export class PlaywrightAdapter {
  constructor(url) {
    this.url = url;
    this.name = 'playwright_mcp';
  }
  async start() {
    this.c = new McpStdioClient('npx', [
      '-y',
      '@playwright/mcp@0.0.76',
      '--headless',
      '--isolated',
    ]);
    await this.c.start();
  }
  async navigate() {
    return rec('browser_navigate', await this.c.callTool('browser_navigate', { url: this.url }));
  }
  async snapshot() {
    return rec('browser_snapshot', await this.c.callTool('browser_snapshot', {}));
  }
  async login() {
    await this.c.callTool('browser_navigate', { url: this.url });
    await this.c.callTool('browser_type', {
      element: 'email',
      target: '[data-testid="login-email"]',
      text: LOGIN.email,
    });
    await this.c.callTool('browser_type', {
      element: 'password',
      target: '[data-testid="login-password"]',
      text: LOGIN.password,
    });
    await this.c.callTool('browser_click', {
      element: 'sign in',
      target: '[data-testid="login-submit"]',
    });
    await sleep(800);
  }
  async clickTestid(id, desc) {
    return rec(
      'browser_click',
      await this.c.callTool('browser_click', {
        element: desc ?? id,
        target: `[data-testid="${id}"]`,
      }),
    );
  }
  async console() {
    return rec(
      'browser_console_messages',
      await this.c.callTool('browser_console_messages', { level: 'error' }),
    );
  }
  async network() {
    return rec(
      'browser_network_requests',
      await this.c.callTool('browser_network_requests', { static: false, filter: '/api/' }),
    );
  }
  async stop() {
    await this.c.stop();
  }
}

// ---------- Chrome DevTools MCP ----------
function uidByName(snapText, nameRe) {
  const lines = snapText.split('\n');
  for (const ln of lines) {
    const m = ln.match(/uid=(\S+)\s/);
    if (m && nameRe.test(ln)) return m[1];
  }
  return null;
}
export class DevtoolsAdapter {
  constructor(url) {
    this.url = url;
    this.name = 'chrome_devtools_mcp';
  }
  async start() {
    this.c = new McpStdioClient('npx', [
      '-y',
      'chrome-devtools-mcp@1.3.0',
      '--headless',
      '--isolated',
    ]);
    await this.c.start();
  }
  async navigate() {
    return rec(
      'navigate_page',
      await this.c.callTool('navigate_page', { type: 'url', url: this.url }),
    );
  }
  async snapshot() {
    return rec('take_snapshot', await this.c.callTool('take_snapshot', {}));
  }
  async _snapText() {
    const r = await this.c.callTool('take_snapshot', {});
    return r.text ?? '';
  }
  async login() {
    await this.c.callTool('navigate_page', { type: 'url', url: this.url });
    const snap = await this._snapText();
    const emailUid = uidByName(snap, /textbox "Email"/);
    const passUid = uidByName(snap, /textbox "Password"/);
    const signUid = uidByName(snap, /button "Sign in"/);
    if (emailUid) await this.c.callTool('fill', { uid: emailUid, value: LOGIN.email });
    if (passUid) await this.c.callTool('fill', { uid: passUid, value: LOGIN.password });
    if (signUid) await this.c.callTool('click', { uid: signUid });
    await sleep(800);
  }
  // DevTools references by accessible name; nameRe matches a snapshot line.
  async clickByName(nameRe, label) {
    const snap = await this._snapText();
    const uid = uidByName(snap, nameRe);
    if (!uid)
      return {
        call: 'click',
        error: `no uid for ${label}`,
        latency_ms: 0,
        chars: 0,
        bytes: 0,
        tokens_o200k: 0,
        text: '',
      };
    return rec('click', await this.c.callTool('click', { uid }));
  }
  async console() {
    return rec(
      'list_console_messages',
      await this.c.callTool('list_console_messages', { types: ['error'] }),
    );
  }
  // Fair filter: DevTools has no URL/status filter, but it can restrict by resource type.
  // We give it its best idiomatic path (fetch/xhr only) to avoid penalising it for static assets.
  async network() {
    return rec(
      'list_network_requests',
      await this.c.callTool('list_network_requests', { resourceTypes: ['fetch', 'xhr'] }),
    );
  }
  async networkAll() {
    return rec('list_network_requests', await this.c.callTool('list_network_requests', {}));
  }
  async stop() {
    await this.c.stop();
  }
}

// ---------- Reticle ----------
function reticleRefForTestid(queryText, testid) {
  // reticle_query returns JSON with element descriptors carrying ref + testid.
  try {
    const j = JSON.parse(queryText);
    const arr = j.elements ?? j.matches ?? j.results ?? [];
    for (const e of arr) {
      if (e.ref) return e.ref;
    }
  } catch {
    /* fall through */
  }
  const m = queryText.match(/ref[=:"\s]+([a-z]?e?\d+)/i);
  return m ? m[1] : null;
}
export class ReticleAdapter {
  constructor(url, port = 4455) {
    this.url = url;
    this.port = String(port);
    this.name = 'reticle';
  }
  async start() {
    this.c = new McpStdioClient(
      'node',
      ['packages/server/dist/cli.js', 'mcp', '--port', this.port, '--drive', this.url],
      // The default `hybrid` profile advertises only the core verify tools directly and reaches the
      // rest through 2 meta-tools. This deterministic client calls tools BY NAME (record_start,
      // flow_save, flow_replay…), so it needs them advertised directly — opt into the full profile.
      { RETICLE_PORT: this.port, RETICLE_TOOL_PROFILE: 'full' },
    );
    await this.c.start();
    await sleep(RETICLE_READY_MS); // driven browser load + SDK connect (BENCH_RETICLE_READY_MS to tune)
  }
  async navigate() {
    return rec('reticle_navigate', await this.c.callTool('reticle_navigate', { url: this.url }));
  }
  async snapshot() {
    return rec('reticle_snapshot', await this.c.callTool('reticle_snapshot', { scope: 'page' }));
  }
  async _refByTestid(id) {
    const r = await this.c.callTool('reticle_query', { by: 'testid', value: id });
    return { ref: reticleRefForTestid(r.text ?? '', id), rec: rec('reticle_query', r) };
  }
  // Poll until a testid resolves (post-login render is async + variable). Deterministic settle:
  // a fixed sleep races the auth round-trip, which silently degraded the FIRST nav step at record
  // time (it had no resolvable testid yet) and made the detection bench flaky. Returns when ready.
  async _waitForTestid(id, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const q = await this._refByTestid(id);
      if (q.ref) return true;
      if (Date.now() >= deadline) return false;
      await sleep(150);
    }
  }
  async login() {
    const e = await this._refByTestid('login-email');
    if (e.ref)
      await this.c.callTool('reticle_act', {
        ref: e.ref,
        action: 'fill',
        args: { value: LOGIN.email },
      });
    const p = await this._refByTestid('login-password');
    if (p.ref)
      await this.c.callTool('reticle_act', {
        ref: p.ref,
        action: 'fill',
        args: { value: LOGIN.password },
      });
    const s = await this._refByTestid('login-submit');
    if (s.ref) await this.c.callTool('reticle_act', { ref: s.ref, action: 'click' });
    // Wait for the post-login shell (the nav sidebar) to actually render before any nav step,
    // so the recording captures a real testid anchor instead of a degraded one.
    await this._waitForTestid('nav-deployments');
  }
  async clickTestid(id) {
    const q = await this._refByTestid(id);
    if (!q.ref)
      return {
        call: 'reticle_act',
        error: `no ref for ${id}`,
        latency_ms: 0,
        chars: 0,
        bytes: 0,
        tokens_o200k: 0,
        text: '',
      };
    return rec(
      'reticle_act',
      await this.c.callTool('reticle_act', { ref: q.ref, action: 'click' }),
    );
  }
  async console() {
    return rec('reticle_console', await this.c.callTool('reticle_console', { level: 'error' }));
  }
  // Filter by URL (symmetric with Playwright's '/api/' filter) so this works for BOTH a
  // failed-status request and a pending/no-status request. Status-only filtering would
  // miss a hanging request (it has no status yet) — that was an unfair earlier handicap.
  async network() {
    return rec(
      'reticle_network',
      await this.c.callTool('reticle_network', { urlContains: '/api/' }),
    );
  }
  async networkAll() {
    return rec('reticle_network', await this.c.callTool('reticle_network', {}));
  }
  async stop() {
    try {
      await this.c.callTool('reticle_end_session', { summary: 'bench' }, 5000);
    } catch {
      /* noop */
    }
    await this.c.stop();
    // Explicit daemon teardown — reticle mcp leaves a persistent daemon + driven browser otherwise.
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(
        'node',
        ['packages/server/dist/cli.js', 'stop', '--port', this.port, '--quiet'],
        { stdio: 'ignore' },
      );
    } catch {
      /* noop */
    }
  }
}

// ---------- Vercel agent-browser (vercel-labs/agent-browser) ----------
// A token-efficient browser-automation CLI (Rust core, ref-based accessibility snapshots) that
// claims ~93% context reduction vs Playwright MCP. Driven exactly like the other tools: a discovery
// snapshot resolves stable @refs by accessible name (same model as DevTools' uid-by-name), then act,
// then the targeted observation. CLI, not MCP — invoked via npx, daemon persists state across calls.
const AGENT_BROWSER_PKG = 'agent-browser@0.31.1';
/** Resolve a ref from a ref-snapshot line matching nameRe. Format: `role "Name" [ref=eN]`. The prefix
 * is the tool's ref sigil ('@' for agent-browser, '' for playwright-cli). */
function refByName(snapText, nameRe, prefix = '@') {
  for (const ln of snapText.split('\n')) {
    if (!nameRe.test(ln)) continue;
    const m = ln.match(/\[ref=(\w+)/);
    if (m) return `${prefix}${m[1]}`;
  }
  return null;
}
export class AgentBrowserAdapter {
  constructor(url) {
    this.url = url;
    this.name = 'agent_browser';
    this.session = 'reticle-bench';
  }
  async _run(args) {
    const started = Date.now();
    let text = '';
    try {
      const { stdout } = await pexecFile(
        'npx',
        ['-y', AGENT_BROWSER_PKG, ...args, '--session', this.session],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      text = stdout;
    } catch (e) {
      // agent-browser exits non-zero on some no-op states; the payload is still on stdout/stderr.
      text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    return { text, latencyMs: Date.now() - started };
  }
  async start() {
    await this._run(['open', this.url]);
    await sleep(1500);
  }
  async navigate() {
    return rec('open', await this._run(['open', this.url]));
  }
  async snapshot() {
    // -i = interactive elements only: agent-browser's lean, ref-bearing accessibility snapshot.
    return rec('snapshot', await this._run(['snapshot', '-i']));
  }
  async _snapText() {
    const r = await this._run(['snapshot', '-i']);
    return r.text ?? '';
  }
  async login() {
    const snap = await this._snapText();
    const eRef = refByName(snap, /textbox "Email"/);
    const pRef = refByName(snap, /textbox "Password"/);
    const sRef = refByName(snap, /button "Sign in"/);
    if (eRef) await this._run(['fill', eRef, LOGIN.email]);
    if (pRef) await this._run(['fill', pRef, LOGIN.password]);
    if (sRef) await this._run(['click', sRef]);
    await sleep(800);
  }
  // Resolve by accessible name from a fresh discovery snapshot, then click the @ref.
  async clickByName(nameRe, label) {
    const snap = await this._snapText();
    const ref = refByName(snap, nameRe);
    if (!ref)
      return {
        call: 'click',
        error: `no ref for ${label}`,
        latency_ms: 0,
        chars: 0,
        bytes: 0,
        tokens_o200k: 0,
        text: '',
      };
    return rec('click', await this._run(['click', ref]));
  }
  async console() {
    return rec('console', await this._run(['console']));
  }
  // Restrict to API traffic (xhr/fetch) — its idiomatic lean path, symmetric with DevTools.
  async network() {
    return rec('network', await this._run(['network', 'requests', '--type', 'xhr,fetch']));
  }
  async networkAll() {
    return rec('network', await this._run(['network', 'requests']));
  }
  async stop() {
    await this._run(['close']).catch(() => undefined);
  }
}

// ---------- Microsoft Playwright CLI (@playwright/cli) ----------
// The Playwright team's token-efficient CLI ("playwright mcp commands from terminal"): daemon-backed,
// ref-based YAML accessibility snapshots, claims ~4.6x fewer tokens than Playwright MCP (snapshots can
// spill to disk). Deterministic + scriptable, so it slots into Layer A. Refs are bare `eN` (no sigil).
const PLAYWRIGHT_CLI_PKG = '@playwright/cli@0.1.14';
export class PlaywrightCliAdapter {
  constructor(url) {
    this.url = url;
    this.name = 'playwright_cli';
    this.session = 'pwcli-bench';
  }
  async _run(args) {
    const started = Date.now();
    let text = '';
    try {
      const { stdout } = await pexecFile(
        'npx',
        ['-y', PLAYWRIGHT_CLI_PKG, `-s=${this.session}`, ...args],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      text = stdout;
    } catch (e) {
      text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    return { text, latencyMs: Date.now() - started };
  }
  async start() {
    await this._run(['open', this.url]);
    await sleep(1500);
  }
  async navigate() {
    return rec('goto', await this._run(['goto', this.url]));
  }
  async snapshot() {
    return rec('snapshot', await this._run(['snapshot']));
  }
  async _snapText() {
    const r = await this._run(['snapshot']);
    return r.text ?? '';
  }
  async login() {
    const snap = await this._snapText();
    const eRef = refByName(snap, /textbox "Email"/, '');
    const pRef = refByName(snap, /textbox "Password"/, '');
    const sRef = refByName(snap, /button "Sign in"/, '');
    if (eRef) await this._run(['fill', eRef, LOGIN.email]);
    if (pRef) await this._run(['fill', pRef, LOGIN.password]);
    if (sRef) await this._run(['click', sRef]);
    await sleep(800);
  }
  async clickByName(nameRe, label) {
    const snap = await this._snapText();
    const ref = refByName(snap, nameRe, '');
    if (!ref)
      return {
        call: 'click',
        error: `no ref for ${label}`,
        latency_ms: 0,
        chars: 0,
        bytes: 0,
        tokens_o200k: 0,
        text: '',
      };
    return rec('click', await this._run(['click', ref]));
  }
  async console() {
    return rec('console', await this._run(['console']));
  }
  // `requests` already hides static assets by default — its idiomatic lean network view (API traffic).
  async network() {
    return rec('requests', await this._run(['requests']));
  }
  async networkAll() {
    return rec('requests', await this._run(['requests', '--static']));
  }
  async stop() {
    await this._run(['close']).catch(() => undefined);
  }
}

// Unified view-navigation + tap + observe so scenarios are tool-agnostic.
// NAV maps a view id to a testid (Playwright/Reticle) and an accessible-name regex (DevTools).
// DevTools resolves nav by accessible name. Match the LABEL PREFIX (open-quote + word, no closing
// quote) so a trailing badge count — e.g. the Deployments nav renders "Deployments500" — still
// resolves. The earlier exact-quote regex missed it, making DevTools fail to reach the view (an
// apparatus miss, not a real one).
const NAV = {
  overview: { testid: 'nav-overview', nameRe: /"Overview/ },
  deployments: { testid: 'nav-deployments', nameRe: /"Deployments/ },
  compose: { testid: 'nav-compose', nameRe: /"Compose/ },
  diagnostics: { testid: 'nav-diagnostics', nameRe: /"Diagnostics/ },
};
for (const Cls of [PlaywrightAdapter, ReticleAdapter]) {
  Cls.prototype.tap = function (spec) {
    return this.clickTestid(spec.testid, spec.label);
  };
  Cls.prototype.gotoView = function (v) {
    return this.clickTestid(NAV[v].testid, v);
  };
}
// DevTools, agent-browser, and playwright-cli all resolve by accessible name from a discovery snapshot.
for (const Cls of [DevtoolsAdapter, AgentBrowserAdapter, PlaywrightCliAdapter]) {
  Cls.prototype.tap = function (spec) {
    return this.clickByName(spec.nameRe, spec.label ?? spec.testid);
  };
  Cls.prototype.gotoView = function (v) {
    return this.clickByName(NAV[v].nameRe, v);
  };
}
for (const Cls of [
  PlaywrightAdapter,
  DevtoolsAdapter,
  ReticleAdapter,
  AgentBrowserAdapter,
  PlaywrightCliAdapter,
]) {
  Cls.prototype.observe = function (kind) {
    if (kind === 'console') return this.console();
    if (kind === 'network') return this.network();
    if (kind === 'networkAll') return this.networkAll ? this.networkAll() : this.network();
    return this.snapshot();
  };
}

export { NAV };
export function makeAdapter(tool, url) {
  if (tool === 'playwright') return new PlaywrightAdapter(url);
  if (tool === 'devtools') return new DevtoolsAdapter(url);
  if (tool === 'reticle') return new ReticleAdapter(url);
  if (tool === 'agentbrowser') return new AgentBrowserAdapter(url);
  if (tool === 'playwrightcli') return new PlaywrightCliAdapter(url);
  throw new Error(`unknown tool ${tool}`);
}
