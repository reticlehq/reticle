// Per-tool adapters: login -> navigate -> act -> observe, each call MEASURED.
// Fairness: every adapter pays for a realistic discovery snapshot of the page it
// must act on (an agent can't guess refs/uids), then acts via the most robust
// locator available, then runs the targeted observation. We measure the payloads
// the agent would receive; the physical locator used to drive the click does not
// change those payloads.
import { McpStdioClient } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';

const LOGIN = { email: 'admin@iris.dev', password: 'password' };

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

// ---------- Iris ----------
function irisRefForTestid(queryText, testid) {
  // iris_query returns JSON with element descriptors carrying ref + testid.
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
export class IrisAdapter {
  constructor(url, port = 4455) {
    this.url = url;
    this.port = String(port);
    this.name = 'iris';
  }
  async start() {
    this.c = new McpStdioClient(
      'node',
      ['packages/server/dist/cli.js', 'mcp', '--port', this.port, '--drive', this.url],
      { IRIS_PORT: this.port },
    );
    await this.c.start();
    await sleep(3500); // driven browser load + SDK connect
  }
  async navigate() {
    return rec('iris_navigate', await this.c.callTool('iris_navigate', { url: this.url }));
  }
  async snapshot() {
    return rec('iris_snapshot', await this.c.callTool('iris_snapshot', { scope: 'page' }));
  }
  async _refByTestid(id) {
    const r = await this.c.callTool('iris_query', { by: 'testid', value: id });
    return { ref: irisRefForTestid(r.text ?? '', id), rec: rec('iris_query', r) };
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
      await this.c.callTool('iris_act', {
        ref: e.ref,
        action: 'fill',
        args: { value: LOGIN.email },
      });
    const p = await this._refByTestid('login-password');
    if (p.ref)
      await this.c.callTool('iris_act', {
        ref: p.ref,
        action: 'fill',
        args: { value: LOGIN.password },
      });
    const s = await this._refByTestid('login-submit');
    if (s.ref) await this.c.callTool('iris_act', { ref: s.ref, action: 'click' });
    // Wait for the post-login shell (the nav sidebar) to actually render before any nav step,
    // so the recording captures a real testid anchor instead of a degraded one.
    await this._waitForTestid('nav-deployments');
  }
  async clickTestid(id) {
    const q = await this._refByTestid(id);
    if (!q.ref)
      return {
        call: 'iris_act',
        error: `no ref for ${id}`,
        latency_ms: 0,
        chars: 0,
        bytes: 0,
        tokens_o200k: 0,
        text: '',
      };
    return rec('iris_act', await this.c.callTool('iris_act', { ref: q.ref, action: 'click' }));
  }
  async console() {
    return rec('iris_console', await this.c.callTool('iris_console', { level: 'error' }));
  }
  // Filter by URL (symmetric with Playwright's '/api/' filter) so this works for BOTH a
  // failed-status request and a pending/no-status request. Status-only filtering would
  // miss a hanging request (it has no status yet) — that was an unfair earlier handicap.
  async network() {
    return rec('iris_network', await this.c.callTool('iris_network', { urlContains: '/api/' }));
  }
  async networkAll() {
    return rec('iris_network', await this.c.callTool('iris_network', {}));
  }
  async stop() {
    try {
      await this.c.callTool('iris_end_session', { summary: 'bench' }, 5000);
    } catch {
      /* noop */
    }
    await this.c.stop();
    // Explicit daemon teardown — iris mcp leaves a persistent daemon + driven browser otherwise.
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

// Unified view-navigation + tap + observe so scenarios are tool-agnostic.
// NAV maps a view id to a testid (Playwright/Iris) and an accessible-name regex (DevTools).
const NAV = {
  overview: { testid: 'nav-overview', nameRe: /"Overview"/ },
  deployments: { testid: 'nav-deployments', nameRe: /"Deployments"/ },
  compose: { testid: 'nav-compose', nameRe: /"Compose"/ },
  diagnostics: { testid: 'nav-diagnostics', nameRe: /"Diagnostics"/ },
};
for (const Cls of [PlaywrightAdapter, IrisAdapter]) {
  Cls.prototype.tap = function (spec) {
    return this.clickTestid(spec.testid, spec.label);
  };
  Cls.prototype.gotoView = function (v) {
    return this.clickTestid(NAV[v].testid, v);
  };
}
DevtoolsAdapter.prototype.tap = function (spec) {
  return this.clickByName(spec.nameRe, spec.label ?? spec.testid);
};
DevtoolsAdapter.prototype.gotoView = function (v) {
  return this.clickByName(NAV[v].nameRe, v);
};
for (const Cls of [PlaywrightAdapter, DevtoolsAdapter, IrisAdapter]) {
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
  if (tool === 'iris') return new IrisAdapter(url);
  throw new Error(`unknown tool ${tool}`);
}
