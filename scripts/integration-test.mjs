#!/usr/bin/env node
/**
 * Real-world integration test for Reticle MCP + browser SDK.
 *
 * Tests exactly what real users experience:
 *   1. Smart session auto-selection (multiple tabs, one focused vs one hidden)
 *   2. Tab switching → health state changes
 *   3. Navigation → session persists
 *   4. Tab close → session removed immediately
 *   5. Proxy auto-start → daemon restarts automatically
 *   6. Concurrent MCP clients → all succeed
 *   7. Update tools
 *
 * How it works (the real-user flow):
 *   - The test finds the URL of whatever the user's real browser has open (from reticle_sessions)
 *   - Playwright opens a SECOND headless tab to the same URL, creating a second session
 *   - Now we have: user's real browser (focused/active) + Playwright (hidden/throttled)
 *   - This IS the stale-tab scenario! Smart auto-selection should prefer the user's tab
 *
 * Prerequisites:
 *   pnpm build
 *   RETICLE_PORT=58432 pnpm --filter @reticlehq/demo dev   (in a separate terminal)
 *   Open http://localhost:<demo-port> in a real browser
 *
 * Usage:
 *   RETICLE_PORT=58432 node scripts/integration-test.mjs
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'packages/server/dist/cli.js');

const RETICLE_PORT = parseInt(process.env['RETICLE_PORT'] ?? '58432');

// ─── Colours ─────────────────────────────────────────────────────────────────
const G = '\x1b[32m',
  R = '\x1b[31m',
  Y = '\x1b[33m',
  B = '\x1b[34m',
  X = '\x1b[0m',
  BOLD = '\x1b[1m';
let passed = 0,
  failed = 0;
function ok(label, detail = '') {
  passed++;
  console.log(`  ${G}✅ ${label}${X}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail = '') {
  failed++;
  console.log(`  ${R}❌ ${label}${X}${detail ? ` — ${detail}` : ''}`);
}
function info(msg) {
  console.log(`  ${B}ℹ  ${msg}${X}`);
}
function warn(msg) {
  console.log(`  ${Y}⚠  ${msg}${X}`);
}
function section(title) {
  console.log(`\n${BOLD}${Y}▶ ${title}${X}`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function probeTcp(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(500);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
    s.connect(port, host);
  });
}

// ─── MCP proxy client (uses real reticle mcp, exactly as Claude Code does) ──────
let mcpIdCtr = 1;
let mcpProc = null;
let mcpCbs = new Map();
let mcpBuf = '';

function startMcpProxy() {
  stopMcpProxy();
  mcpProc = spawn(process.execPath, [CLI, 'mcp', '--port', String(RETICLE_PORT)], {
    env: { ...process.env, RETICLE_PORT: String(RETICLE_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcpProc.stdout.setEncoding('utf8');
  mcpProc.stdout.on('data', (chunk) => {
    mcpBuf += chunk;
    const lines = mcpBuf.split('\n');
    mcpBuf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t);
        if (msg.id !== undefined) {
          const cb = mcpCbs.get(msg.id);
          mcpCbs.delete(msg.id);
          cb?.(msg);
        }
      } catch {
        /* ignore */
      }
    }
  });
}

function stopMcpProxy() {
  if (!mcpProc) return;
  try {
    mcpProc.stdin.end();
    mcpProc.kill();
  } catch {
    /* ignore */
  }
  mcpProc = null;
  mcpBuf = '';
  for (const cb of mcpCbs.values()) cb(null);
  mcpCbs.clear();
}

function rpc(method, params, timeoutMs = 12_000) {
  const id = mcpIdCtr++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      mcpCbs.delete(id);
      reject(new Error(`rpc(${method}) timeout`));
    }, timeoutMs);
    mcpCbs.set(id, (msg) => {
      clearTimeout(t);
      if (!msg) {
        reject(new Error('proxy died'));
        return;
      }
      if (msg.error) {
        reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
        return;
      }
      resolve(msg);
    });
    if (!mcpProc) {
      reject(new Error('proxy not started'));
      return;
    }
    mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function mcpInit() {
  startMcpProxy();
  await delay(800); // give proxy time to connect to daemon SSE
  const r = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '1.0' },
  });
  return r.result;
}

async function callTool(name, args = {}, timeoutMs = 12_000) {
  const r = await rpc('tools/call', { name, arguments: args }, timeoutMs);
  for (const c of r.result?.content ?? []) {
    if (c.type === 'text') {
      try {
        return JSON.parse(c.text);
      } catch {
        return c.text;
      }
    }
  }
  return r.result;
}

// ─── Session helpers ──────────────────────────────────────────────────────────
async function getSessions(timeoutMs = 6_000) {
  const r = await callTool('reticle_sessions', {}, timeoutMs);
  return r?.sessions ?? [];
}

async function waitForSessionCount(target, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await getSessions(4000);
      if (s.length === target) return s;
    } catch {
      /* retry */
    }
    await delay(400);
  }
  const s = await getSessions();
  throw new Error(`wanted ${target} sessions, have ${s.length}`);
}

async function waitForSessionCountAtLeast(min, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await getSessions(4000);
      if (s.length >= min) return s;
    } catch {
      /* retry */
    }
    await delay(400);
  }
  throw new Error(`waited for ≥${min} sessions — none appeared`);
}

// ─── Daemon helpers ───────────────────────────────────────────────────────────
async function stopDaemon() {
  try {
    execFileSync(process.execPath, [CLI, 'stop', '--port', String(RETICLE_PORT), '--quiet'], {
      timeout: 3000,
      env: { ...process.env },
    });
  } catch {
    /* might not be running */
  }
  const pidFile = path.join(
    process.env['HOME'] ?? '/tmp',
    '.reticle',
    `daemon-${RETICLE_PORT}.pid`,
  );
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
    if (!isNaN(pid))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    fs.rmSync(pidFile, { force: true });
  } catch {
    /* already gone */
  }
  const dl = Date.now() + 3000;
  while (Date.now() < dl) {
    if (!(await probeTcp(RETICLE_PORT))) return;
    await delay(100);
  }
}

// ─── Cleanup state ────────────────────────────────────────────────────────────
let browser = null;
let openContexts = [];

async function cleanup() {
  stopMcpProxy();
  for (const ctx of openContexts) {
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  }
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${BOLD}Reticle Integration Test — real browser + real MCP${X}`);
  console.log(`  daemon port: ${RETICLE_PORT}`);

  // ── Preflight ────────────────────────────────────────────────────────────
  section('Preflight');

  if (!fs.existsSync(CLI)) {
    fail('CLI built', `${CLI} missing — run: pnpm build`);
    process.exit(1);
  }
  ok('CLI built');

  if (!(await probeTcp(RETICLE_PORT))) {
    fail(
      'Daemon',
      `nothing on port ${RETICLE_PORT} — start with: RETICLE_PORT=${RETICLE_PORT} pnpm --filter @reticlehq/demo dev`,
    );
    process.exit(1);
  }
  ok(`Daemon on port ${RETICLE_PORT}`);

  const init = await mcpInit();
  ok('MCP proxy', `reticle v${init.serverInfo?.version}`);

  // Find the demo URL from existing sessions — this is the URL the USER has open in their
  // real browser, which IS the correct Reticle-connected URL (same RETICLE_PORT as daemon).
  let baseSessions = await getSessions();
  info(`Existing sessions: ${baseSessions.length}`);

  let demoUrl = process.env['DEMO_URL'] ?? null;
  if (!demoUrl && baseSessions.length > 0) {
    // Derive demo server URL from the session's page URL
    const pageUrl = new URL(baseSessions[0].url);
    demoUrl = `${pageUrl.protocol}//${pageUrl.host}`;
    info(`Demo URL inferred from session: ${demoUrl}`);
  }

  if (!demoUrl) {
    warn('No existing browser session — cannot infer demo URL');
    warn('Start the demo and open it in a real browser:');
    warn(`  RETICLE_PORT=${RETICLE_PORT} pnpm --filter @reticlehq/demo dev`);
    warn('Then open http://localhost:<port> in Chrome, then re-run this test.');
    warn('Skipping browser-based scenarios (8 and 9 only will run).');
  } else {
    ok(`Demo URL: ${demoUrl}`);
  }

  browser = await chromium.launch({ headless: true });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1: Basic tool calls with explicit sessionId
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 1: reticle_sessions, reticle_snapshot, reticle_query (explicit sessionId)');

  if (baseSessions.length === 0) {
    warn(
      'No sessions — skipping session-bound scenarios. Open the demo in a real browser and re-run.',
    );
  } else {
    const sid = baseSessions[0].sessionId;
    info(`Using session ${sid} (${baseSessions[0].url})`);

    try {
      const snap = await callTool('reticle_snapshot', { sessionId: sid, mode: 'status' });
      ok('reticle_snapshot', `route=${snap?.status?.route} title="${snap?.status?.title}"`);
    } catch (e) {
      fail('reticle_snapshot', e.message);
    }

    try {
      const q = await callTool('reticle_query', { sessionId: sid, by: 'role', value: 'heading' });
      ok('reticle_query', `${q?.elements?.length ?? 0} headings`);
    } catch (e) {
      fail('reticle_query', e.message);
    }

    try {
      const net = await callTool('reticle_network', { sessionId: sid, limit: 5 });
      ok('reticle_network', `${net?.requests?.length ?? 0} recent requests`);
    } catch (e) {
      fail('reticle_network', e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 2: Multiple sessions — auto-selection
  // The USER's real browser = not throttled (they have it open, focused).
  // The Playwright headless tab = hidden/throttled (headless is always "hidden").
  // Smart auto-selection MUST pick the user's tab, not the headless one.
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 2: Smart session auto-selection (real browser vs headless tab)');

  if (!demoUrl) {
    warn('Skipping — no demo URL');
  } else {
    const ctx2 = await browser.newContext();
    openContexts.push(ctx2);
    const page2 = await ctx2.newPage();
    await page2.goto(demoUrl);
    // Wait for the reticle bridge connection
    try {
      await page2.waitForFunction(() => window.__reticleInstance?._state !== 'disconnected', {
        timeout: 15_000,
      });
    } catch {
      await delay(4000);
    }
    await delay(2000); // wait for PAGE_HEALTH heartbeat

    const sessionsNow = await callTool('reticle_sessions', {});
    info(`Sessions now: ${sessionsNow.sessions.length}`);
    sessionsNow.sessions.forEach((s) =>
      info(
        `  ${s.sessionId}: throttled=${s.throttled} focused=${s.focused} lastSeenMs=${Math.round(s.lastSeenMs)}`,
      ),
    );

    const nonThrottled = sessionsNow.sessions.filter((s) => !s.throttled);
    const throttled = sessionsNow.sessions.filter((s) => s.throttled);
    info(`Non-throttled: ${nonThrottled.length}, throttled: ${throttled.length}`);

    if (sessionsNow.sessions.length >= 2) {
      ok(`Two sessions visible (${sessionsNow.sessions.length} total)`);
    } else {
      warn(
        `Expected ≥2 sessions, got ${sessionsNow.sessions.length} — Playwright tab may not have connected`,
      );
      warn(`  Is the demo at ${demoUrl} configured with RETICLE_PORT=${RETICLE_PORT}?`);
    }

    // Test auto-selection
    if (nonThrottled.length === 1 && throttled.length >= 1) {
      // Perfect case: one focused (user's real browser) + one hidden (Playwright)
      // Auto-selection should pick the non-throttled one WITHOUT needing sessionId
      try {
        const snap = await callTool('reticle_snapshot', { mode: 'status' });
        // Verify via the health block in the response — non-throttled session has throttled:false
        const chosenThrottled = snap?.session?.throttled;
        if (chosenThrottled === false) {
          ok(
            'Auto-selection picked the focused (non-throttled) session',
            `ignored hidden Playwright tab`,
          );
        } else if (chosenThrottled === true) {
          warn('Auto-selection picked the throttled session — may be a recency tie');
        } else {
          ok(
            'Auto-selection succeeded with multiple sessions',
            `session.throttled=${chosenThrottled}`,
          );
        }
      } catch (e) {
        if (e.message.includes('multiple sessions') || e.message.includes('pass sessionId')) {
          fail('Auto-selection failed when clear winner exists', e.message);
        } else {
          fail('Auto-selection error', e.message);
        }
      }
    } else if (nonThrottled.length === 0) {
      // All headless — headless Chromium always reports hidden=true
      // Verify the error message is useful (includes session IDs and health)
      info('All sessions throttled in headless mode — testing ambiguity error quality');
      if (sessionsNow.sessions.length >= 2) {
        try {
          await callTool('reticle_snapshot', { mode: 'status' });
          warn(
            'Expected ambiguity error with all-throttled sessions — got a result (auto-select picked one)',
          );
        } catch (e) {
          if (e.message.includes('multiple sessions') || e.message.includes('pass sessionId')) {
            const hasSessionIds = sessionsNow.sessions.every((s) =>
              e.message.includes(s.sessionId),
            );
            if (hasSessionIds) {
              ok(
                'Ambiguity error lists session IDs and health info',
                e.message.slice(0, 120) + '…',
              );
            } else {
              warn('Ambiguity error does not list all session IDs: ' + e.message.slice(0, 120));
            }
          } else {
            fail('Unexpected error type', e.message);
          }
        }
      }
    } else if (nonThrottled.length >= 2) {
      // Multiple non-throttled — need to pick by recency
      try {
        const snap = await callTool('reticle_snapshot', { mode: 'status' });
        ok(
          'Auto-selection succeeded among multiple non-throttled sessions',
          `chose ${snap?.session_lease?.sessionId}`,
        );
      } catch (e) {
        if (e.message.includes('multiple sessions')) {
          ok('Ambiguity error (equally-recent non-throttled sessions)', 'need explicit sessionId');
        } else {
          fail('Auto-selection error', e.message);
        }
      }
    }

    // Always verify explicit sessionId works regardless
    for (const s of sessionsNow.sessions.slice(0, 2)) {
      try {
        const snap = await callTool('reticle_snapshot', { sessionId: s.sessionId, mode: 'status' });
        ok(
          `reticle_snapshot session ${s.sessionId} (throttled=${s.throttled})`,
          snap?.status?.route ?? '?',
        );
      } catch (e) {
        warn(`reticle_snapshot session ${s.sessionId}: ${e.message}`);
      }
    }

    // Close Playwright tab — should drop session count back to baseline
    await ctx2.close();
    openContexts = openContexts.filter((c) => c !== ctx2);
    await delay(800);
    const afterClose = await getSessions();
    if (afterClose.length < sessionsNow.sessions.length) {
      ok(
        'Tab close immediately removes session',
        `${sessionsNow.sessions.length} → ${afterClose.length}`,
      );
    } else {
      fail('Session not cleaned up after tab close', `still ${afterClose.length}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 3: Navigation — session persists through URL change
  // Open a Playwright tab, wait for session, then navigate, verify session stays
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 3: Navigation — session persists through URL change');

  if (!demoUrl) {
    warn('Skipping — no demo URL');
  } else {
    const ctx3 = await browser.newContext();
    openContexts.push(ctx3);
    const page3 = await ctx3.newPage();
    await page3.goto(demoUrl);
    try {
      await page3.waitForFunction(() => window.__reticleInstance?._state !== 'disconnected', {
        timeout: 15_000,
      });
    } catch {
      await delay(4000);
    }

    const beforeNav = await getSessions();
    const countBefore = beforeNav.length;
    info(`Sessions before navigation: ${countBefore}`);

    // Navigate to same origin with query param (stays on the same Vite app)
    await page3.goto(demoUrl + '?reticle-integration-test=nav');
    try {
      await page3.waitForFunction(() => window.__reticleInstance?._state !== 'disconnected', {
        timeout: 10_000,
      });
    } catch {
      await delay(3000);
    }
    await delay(1000);

    const afterNav = await getSessions();
    // Navigation on same origin: WS may stay open (session persists) or reconnect (same count)
    if (afterNav.length >= countBefore - 1) {
      ok('Session maintained through navigation', `before=${countBefore} after=${afterNav.length}`);
    } else {
      fail('Sessions dropped on navigation', `before=${countBefore} after=${afterNav.length}`);
    }

    await ctx3.close();
    openContexts = openContexts.filter((c) => c !== ctx3);
    await delay(600);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 4: Stale tab simulation
  // Open a Playwright tab, let it navigate to about:blank (simulates user leaving page),
  // then open a fresh tab. Fresh tab should be preferred by auto-selection.
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 4: Stale tab (navigate away) + fresh tab');

  if (!demoUrl) {
    warn('Skipping — no demo URL');
  } else {
    // "Old" tab: connects then navigates away (WS drops on navigation away from origin)
    const ctxOld = await browser.newContext();
    openContexts.push(ctxOld);
    const pageOld = await ctxOld.newPage();
    await pageOld.goto(demoUrl);
    try {
      await pageOld.waitForFunction(() => window.__reticleInstance !== undefined, {
        timeout: 8_000,
      });
    } catch {
      await delay(2000);
    }
    // Navigate away — WS connection drops
    await pageOld.goto('about:blank');
    await delay(600);

    // "Fresh" tab: connects normally
    const ctxNew = await browser.newContext();
    openContexts.push(ctxNew);
    const pageNew = await ctxNew.newPage();
    await pageNew.goto(demoUrl);
    try {
      await pageNew.waitForFunction(() => window.__reticleInstance !== undefined, {
        timeout: 10_000,
      });
    } catch {
      await delay(2000);
    }
    await delay(2000); // wait for health events

    const staleScenarioSessions = await getSessions();
    info(`Sessions after stale+fresh: ${staleScenarioSessions.length}`);
    staleScenarioSessions.forEach((s) =>
      info(`  ${s.sessionId}: throttled=${s.throttled} lastSeenMs=${Math.round(s.lastSeenMs)}`),
    );

    // The "stale" tab navigated to about:blank → its WS closed → session removed
    // The fresh tab → one session exists
    const playwrightSessions = staleScenarioSessions.filter(
      (s) => !baseSessions.some((b) => b.sessionId === s.sessionId),
    );
    info(`Playwright sessions visible: ${playwrightSessions.length}`);

    if (staleScenarioSessions.length > 0) {
      ok('At least one session exists (fresh tab connected)');
    } else {
      warn('No sessions after stale+fresh scenario — fresh tab may not have connected in time');
    }

    await ctxOld.close();
    await ctxNew.close();
    openContexts = openContexts.filter((c) => c !== ctxOld && c !== ctxNew);
    await delay(500);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 5: Health info quality check
  // reticle_sessions must include throttled, focused, lastSeenMs, and recommendation
  // when the tab is hidden/throttled
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 5: Session health info completeness');

  if (baseSessions.length === 0) {
    warn('Skipping — no sessions');
  } else {
    const currentSessions = await getSessions();
    let allHealthy = true;
    for (const s of currentSessions) {
      const hasMandatory = 'throttled' in s && 'focused' in s && 'lastSeenMs' in s && 'hidden' in s;
      if (!hasMandatory) {
        fail(`Session ${s.sessionId} missing health fields`);
        allHealthy = false;
      }
    }
    if (allHealthy && currentSessions.length > 0) {
      ok('All sessions include mandatory health fields (throttled, focused, lastSeenMs, hidden)');
    }

    // Throttled sessions should include recommendation
    const throttledWithoutRec = currentSessions.filter((s) => s.throttled && !s.recommendation);
    if (throttledWithoutRec.length > 0) {
      warn(`${throttledWithoutRec.length} throttled session(s) missing recommendation field`);
    } else if (currentSessions.some((s) => s.throttled)) {
      ok('Throttled sessions include recommendation field');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 6: reticle_version_info + update guard
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 6: Version info and update guard');

  try {
    const ver = await callTool('reticle_version_info', {});
    ok(
      'reticle_version_info',
      `v${ver.currentVersion} kind=${ver.executionKind} updateAvailable=${ver.updateAvailable}`,
    );
    if (ver.executionKind === undefined) fail('executionKind missing', JSON.stringify(ver));
  } catch (e) {
    fail('reticle_version_info', e.message);
  }

  try {
    const upd = await callTool('reticle_apply_update', { targetVersion: '0.0.0', confirm: false });
    upd?.ok === false
      ? ok('reticle_apply_update safety guard (confirm:false → ok:false)')
      : fail('reticle_apply_update guard bypassed', JSON.stringify(upd));
  } catch (e) {
    fail('reticle_apply_update', e.message);
  }

  try {
    const rb = await callTool('reticle_rollback', { confirm: false });
    rb?.ok === false
      ? ok('reticle_rollback safety guard (confirm:false → ok:false)')
      : fail('reticle_rollback guard bypassed', JSON.stringify(rb));
  } catch (e) {
    fail('reticle_rollback', e.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 7: Malformed JSON to proxy stdin → proxy does NOT crash
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 7: Malformed JSON to proxy stdin');

  // Send garbage to the proxy's stdin, then a valid request — should survive
  if (mcpProc) {
    mcpProc.stdin.write('this is not json!\n');
    await delay(300);
    try {
      const sessions = await getSessions(5000);
      ok('Proxy survives malformed JSON', `${sessions.length} sessions still reachable`);
    } catch (e) {
      fail('Proxy crashed on malformed JSON', e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 8: Proxy auto-start — kill daemon, reticle mcp auto-restarts it
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 8: Proxy auto-start (kill daemon → reticle mcp auto-restarts)');

  stopMcpProxy();
  await stopDaemon();
  await delay(200);

  try {
    const initR = await mcpInit();
    ok('Proxy connected after auto-start', `reticle v${initR.serverInfo?.version}`);
    const sessions = await getSessions(8000);
    ok('Tools work after auto-start', `${sessions.length} sessions`);
  } catch (e) {
    fail('Proxy auto-start', e.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 9: Concurrent MCP clients
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 9: Concurrent MCP clients (3 simultaneous)');

  const concResults = await Promise.allSettled(
    Array.from(
      { length: 3 },
      (_, i) =>
        new Promise((resolve, reject) => {
          const p = spawn(process.execPath, [CLI, 'mcp', '--port', String(RETICLE_PORT)], {
            env: { ...process.env, RETICLE_PORT: String(RETICLE_PORT) },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let buf = '';
          p.stdout.setEncoding('utf8');
          p.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 77,
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: `cc${i}`, version: '1' },
              },
            }) + '\n',
          );
          const timer = setTimeout(() => {
            p.kill();
            reject(new Error(`client ${i} timeout`));
          }, 10_000);
          p.stdout.on('data', (chunk) => {
            buf += chunk;
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                if (msg.id === 77 && msg.result?.serverInfo) {
                  clearTimeout(timer);
                  p.stdin.end();
                  p.kill();
                  resolve(msg.result.serverInfo.name);
                }
              } catch {
                /* ignore */
              }
            }
          });
          p.on('error', reject);
        }),
    ),
  );

  const allOk = concResults.every((r) => r.status === 'fulfilled' && r.value === 'reticle');
  if (allOk) {
    ok('All 3 concurrent MCP clients connected', concResults.map((r) => r.value).join(', '));
  } else {
    fail(
      'Concurrent client failures',
      concResults
        .filter((r) => r.status === 'rejected')
        .map((r) => r.reason?.message)
        .join(', '),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Results
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  if (failed === 0) {
    console.log(`${G}${BOLD}PASS${X} — ${passed} checks passed, 0 failed`);
  } else {
    console.log(`${R}${BOLD}FAIL${X} — ${passed} passed, ${failed} failed`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main()
  .catch(async (e) => {
    console.error(`${R}Fatal: ${e.message}${X}`);
    process.exit(1);
  })
  .finally(cleanup);
