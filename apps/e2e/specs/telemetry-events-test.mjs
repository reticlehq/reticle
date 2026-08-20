/**
 * Every telemetry / feedback / error / crash event, fired for real and checked on the wire.
 *
 * This spec exists because of a bug the unit tests could not have caught. `daemon_stopped` — the one
 * event carrying a whole session — was emitted fire-and-forget microseconds before `process.exit(0)`,
 * so the POST was killed every single time and the event NEVER arrived. Nothing threw. No assertion
 * failed. The only way to see it was to stand up a real HTTP endpoint and notice nothing landed.
 *
 * So this drives the REAL built modules from `dist` against a real capture server: real network, real
 * process semantics, real redaction. It needs no browser and none of the battery's three servers,
 * which also makes it the cheapest and most reliable spec in the suite.
 *
 * Half the checks are leak checks. Telemetry is the one subsystem where a mistake is silent, shipped,
 * and about somebody else's data — so every payload that could carry a secret, a password, a customer
 * email, or a home directory is asserted NOT to.
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
const DIST = join(fileURLToPath(new URL('../../../packages/server/dist', import.meta.url)));
const PORT = 9960;

// Events that happen inside a DAEMON RUN and therefore carry `sessionId`. IMPORTED from core, not
// re-listed: this used to be a hand-copied Set whose own comment said "mirrors core's
// isSessionScoped", and the moment core gained a kind the copy was silently wrong — the new event
// fell into the UNSCOPED bucket, where the assertions are the opposite ones. A vocabulary copied
// out of core is the exact drift the telemetry contract forbids, and it is worst here, in the gate
// that exists to catch telemetry going missing.
const { isSessionScoped } = await import(
  new URL('../../../packages/core/dist/index.js', import.meta.url).href
);
const SESSION_SCOPED_EVENTS = { has: (event) => isSessionScoped(event) };

const captured = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      for (const e of JSON.parse(body).batch) captured.push(e);
    } catch {}
    res.end('ok');
  });
});
await new Promise((r) => server.listen(PORT, r));

process.env.RETICLE_TELEMETRY_URL = `http://localhost:${PORT}`;
process.env.RETICLE_TELEMETRY_KEY = 'phc_probe';
process.env.RETICLE_TELEMETRY = '1';
delete process.env.DO_NOT_TRACK;
delete process.env.VITEST;

// A scratch project OUTSIDE the reticle checkout — the source-checkout guard disables telemetry inside it.
const root = mkdtempSync(join(tmpdir(), 'reticle-verify-'));
process.chdir(root);
writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^15.2.0' } }));
mkdirSync(join(root, '.reticle', 'flows'), { recursive: true });
writeFileSync(join(root, '.reticle', 'flows', 'checkout.json'), '{}');
mkdirSync(join(root, '.git'), { recursive: true });
writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/verify.git\n');

const { getTelemetry } = await import(`${DIST}/telemetry/telemetry.js`);
const { getSessionMetrics, resetSessionMetrics } = await import(`${DIST}/telemetry/session-metrics.js`);
const { installDaemonTelemetry } = await import(`${DIST}/telemetry/daemon-telemetry.js`);
const { installDaemonResilience } = await import(`${DIST}/daemon/daemon-resilience.js`);
const { submitFeedback } = await import(`${DIST}/telemetry/feedback.js`);
const { submitIdentity } = await import(`${DIST}/telemetry/identify.js`);
const { reportCliRun } = await import(`${DIST}/telemetry/cli-telemetry.js`);
const { runTool } = await import(`${DIST}/tools/invoke-tool.js`);
const { TOOLS } = await import(`${DIST}/tools/tools.js`);
const { buildErrorPayload } = await import(`${DIST}/tools/error-recovery.js`);
const { reportVersionChange } = await import(`${DIST}/update/updater.js`);
const { reportMcpConnected, markDaemonStart } = await import(`${DIST}/telemetry/mcp-connection.js`);
const { reportInitOutcome, InitFailure } = await import(`${DIST}/telemetry/init-telemetry.js`);
const { reportMcpOutage, resetOutageReporting, OutageStage } = await import(`${DIST}/mcp/mcp-outage.js`);
const { decideVerified } = await import(`${DIST}/honesty/verified.js`);
// Derived from core, never re-listed here — a copied vocabulary is correct on the day it is written
// and silently wrong at the next addition, which has already cost this repo twice.
const { VerifiedReason } = await import(new URL('../../../packages/core/dist/index.js', import.meta.url).href);
const VERIFIED_REASONS = new Set(Object.values(VerifiedReason));
const { classifyConnectFailure } = await import(`${DIST}/telemetry/connect-failure.js`);

if (!getTelemetry().enabled) {
  console.log('FATAL: telemetry resolved disabled — cannot verify anything');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
/**
 * Wait until the capture endpoint has gone QUIET, rather than sleeping a fixed guess.
 *
 * This was `setTimeout(700)`, used fifteen times before assertions that an event had arrived — a
 * statement about the machine, not about the product, and exactly the shape CLAUDE.md calls a bug.
 * It is the flake: this spec failed the battery twice with no name attached and passed every time it
 * was re-run, which is what a too-short fixed wait looks like from the outside.
 *
 * Adaptive in both directions. On an idle machine it returns in ~120ms instead of 700 (the whole
 * spec settles fifteen times, so that is most of a second back); under load it keeps waiting up to
 * the cap. Nothing about the assertions changes — they still require the events to actually arrive.
 */
const SETTLE_QUIET_MS = 120;
const SETTLE_CAP_MS = 10_000;
const settle = async () => {
  const deadline = Date.now() + SETTLE_CAP_MS;
  let seen = captured.length;
  let quietSince = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 25));
    if (captured.length !== seen) {
      seen = captured.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= SETTLE_QUIET_MS) return;
    if (Date.now() >= deadline) return; // cap: let the assertion below report what is missing
  }
};
const find = (ev) => captured.filter((e) => e.event === ev);

// ── 1. CLI command + flags ────────────────────────────────────────────────────
reportCliRun(['status', '--port', '9000', '--http-token', 'SUPERSECRET']);
await settle();
{
  const e = find('cli_command_run')[0];
  check('cli_command_run fires', e !== undefined);
  check('  carries the subcommand', e?.properties.command === 'status', e?.properties.command);
  check('  carries flag NAMES', JSON.stringify(e?.properties.flags) === '["--http-token","--port"]', JSON.stringify(e?.properties.flags));
  check('  projectId from the git origin', e?.properties.projectIdSource === 'git_origin', e?.properties.projectIdSource);
}
// `_daemon` must NOT fire — this is the double-count fix.
const beforeDaemonArg = find('cli_command_run').length;
reportCliRun(['_daemon', '--port', '9000']);
await settle();
check('_daemon spawn does NOT count as a CLI run', find('cli_command_run').length === beforeDaemonArg);
// Nor does `mcp`. It is the agent's MCP client opening its transport, which no person typed — and it
// was 475 of 561 of this event (85%) in one real day, on an event whose purpose is human intent.
// `mcp_client_connected` already reports an agent attaching, with strictly more detail.
reportCliRun(['mcp', '--port', '9000']);
await settle();
check('`mcp` does NOT count as a CLI run — it is the agent\'s transport, not a typed command', find('cli_command_run').length === beforeDaemonArg);

// ── 1b. Session correlation — the key that ties one daemon run together ───────
{
  // A sessionId means A DAEMON RUN. A one-shot CLI command mints one per PROCESS that joins to
  // nothing — measured over a real day, uniq(sessionId) was 704, of which 561 came from
  // cli_command_run and not one was shared with a daemon. The true daemon count was 121, so every
  // tile counting sessions was ~6x high.
  check('every DAEMON event carries a sessionId', captured.filter((e) => SESSION_SCOPED_EVENTS.has(e.event)).every((e) => typeof e.properties.sessionId === 'string'));
  check('  a one-shot CLI run carries NONE — it is not a session', find('cli_command_run').every((e) => e.properties.sessionId === undefined && e.properties.$session_id === undefined));
  check('  nor does it carry `actor` — human by definition once `mcp` is excluded', find('cli_command_run').every((e) => e.properties.actor === undefined));
  // Dead fields from the v2→v3 migration that nothing set any more.
  check('  the dead sessionMs/tool fields are gone', captured.every((e) => e.properties.sessionMs === undefined && e.properties.tool === undefined));
}

// ── 2. Daemon lifecycle + project profile ─────────────────────────────────────
resetSessionMetrics();
const daemon = installDaemonTelemetry(root);
await settle();
{
  check('daemon_started fires', find('daemon_started').length === 1);
}

// ── 3. Tool calls, params, verification, errors ───────────────────────────────
const metrics = getSessionMetrics();
const fakeSession = {
  id: 's1',
  command: async () => ({ ok: true, result: {} }),
  takeSessionLease: () => undefined,
  ageWarning: () => undefined,
  blindSpots: () => [],
  health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
  throttled: () => false,
};
const deps = { sessions: { resolve: () => fakeSession } };

// A verification tool returning a caught false green: assertion passed, verdict refused it.
const falseGreenTool = {
  name: 'reticle_assert',
  description: '',
  inputSchema: {},
  // The REAL rule, not a hand-written imitation: `verification_reason` only means anything if the
  // clause that decided the verdict is the one that travelled.
  handler: async () => ({
    pass: true,
    ...decideVerified({
      pass: true,
      settled: true,
      honesty: { grade: 'signal', coverage: { partial: false }, integrity: { clean: true, issues: [] } },
      contradictions: [{ kind: 'signal-contradicted' }],
    }),
  }),
};
await runTool(falseGreenTool, deps, { predicate: { kind: 'console' }, since: 1 });
// A clean pass.
const cleanTool = { ...falseGreenTool, handler: async () => ({ pass: true, verified: 'yes' }) };
await runTool(cleanTool, deps, { predicate: { kind: 'console' } });
// A non-verification tool, with a secret-bearing param.
const actTool = { name: 'reticle_act', description: '', inputSchema: {}, handler: async () => ({ dispatched: true }) };
await runTool(actTool, deps, { ref: 'e7', action: 'type', args: 'hunter2-password' });
await settle();
// The envelope the product's MAIN verification tool returns: no top-level `pass`, the verdict
// nested under `verdict`, the summary at `verified`. act_and_wait was absent from
// VERIFICATION_TOOLS AND unreadable by bugsInResult, so every verdict it produced — and every
// failure — was invisible to both metrics. Measured: act_and_wait 14 calls/day, assert 0.
const actAndWaitFail = {
  name: 'reticle_act_and_wait',
  description: '',
  inputSchema: {},
  handler: async () => ({ verified: 'no', verdict: { pass: false, assertion: 'element.visible' } }),
};
await runTool(actAndWaitFail, deps, { ref: 'e7', action: 'click' });
await settle();
{
  const vs = find('verification_completed');
  check('verification_completed fires per verdict', vs.length === 3, `got ${vs.length}`);
  const aw = vs.find((e) => e.properties.verification_via === 'reticle_act_and_wait');
  check('  act_and_wait counts as a verification', aw !== undefined);
  check('  and its failed verdict is recorded as not-passed', aw?.properties.verification_passed === false, String(aw?.properties.verification_passed));
  const bugs = find('bug_found').filter((e) => e.properties.bug_tool === 'reticle_act_and_wait');
  check('  a failed act_and_wait verdict is counted as a bug', bugs.length === 1, `got ${bugs.length}`);
}
{
  const vs = find('verification_completed');
  const fg = vs.find((e) => e.properties.verification_falseGreenCaught === true);
  check('  falseGreenCaught set when a PASS is refused', fg !== undefined);
  check('  clean pass NOT marked as a false green', vs.some((e) => e.properties.verification_falseGreenCaught === false));
  check('  carries which tool produced it', fg?.properties.verification_via === 'reticle_assert');
  check('  actor is the agent', fg?.properties.actor === 'agent', fg?.properties.actor);
}
{
  // WHY the verdict came out that way. `verified: 'unknown'` covered seven different clauses of the
  // honesty rule belonging to three different owners — the agent, the app, and Reticle's own blind
  // spots — and they reached the wire as one value needing three opposite responses.
  const reasoned = find('verification_completed').filter((e) => e.properties.verification_reason !== undefined);
  check('  a verdict from the honesty rule names the clause that decided it', reasoned.length > 0);
  check('  and the clause is from the closed list', reasoned.every((e) => VERIFIED_REASONS.has(e.properties.verification_reason)), reasoned.map((e) => e.properties.verification_reason).join(','));
  check('  a refused green says WHY it was refused', reasoned.some((e) => e.properties.verification_reason === 'contradicted' && e.properties.verification_falseGreenCaught === true));
}

// ── 4. Tool errors → fingerprints ─────────────────────────────────────────────
// The MCP boundary records these; call the same recorder it calls.
metrics.recordToolError("no baseline named 'checkout-v3'", 'reticle_baseline');
metrics.recordToolError("no baseline named 'login-page'", 'reticle_baseline');
metrics.recordToolError('the browser pool is empty', 'reticle_lease');
{
  const payload = buildErrorPayload('a completely novel failure nobody has seen');
  check('unknown tool error asks the agent for an RCA', typeof payload.feedback === 'string');
  const known = buildErrorPayload('no browser session connected');
  check('  known error gets recovery instead, not the ask', typeof known.recovery === 'string' && known.feedback === undefined);
}

// ── 3b. Bugs found — the outcome metric ──────────────────────────────────────
const crawlTool = { name: 'reticle_crawl', description: '', inputSchema: {}, handler: async () => ({
  anomalies: [
    { kind: 'console-error', ref: 'e3', desc: 'button#checkout-SECRETMARKER threw' },
    { kind: 'ui-advanced-request-failed', ref: 'e4', detail: { url: 'https://acme.internal/orders' } },
  ],
}) };
await runTool(crawlTool, deps, {});
const contradictedTool = { ...falseGreenTool, handler: async () => ({
  pass: true, verified: 'no', contradictions: [{ kind: 'signal-contradicted' }],
}) };
await runTool(contradictedTool, deps, { predicate: { kind: 'console' } });
await settle();
{
  const bugs = find('bug_found');
  check('bug_found fires — the number we can publish', bugs.length === 4, `got ${bugs.length}`);
  const fg = bugs.filter((b) => b.properties.bug_falseGreen === true);
  check('  a passing assertion over a contradiction IS a false green', fg.some((b) => b.properties.bug_kind === 'signal-contradicted'));
  check('  a crawl contradiction counts as a false green too', fg.some((b) => b.properties.bug_kind === 'ui-advanced-request-failed'));
  check('  a single-channel console error is NOT inflated into a false green', bugs.some((b) => b.properties.bug_kind === 'console-error' && b.properties.bug_falseGreen === false));
  // The property is "the headline can be broken down", not "there are exactly N sources" — an exact
  // count turns every added case into a failure and says nothing about the breakdown being usable.
  const sources = new Set(bugs.map((b) => b.properties.bug_source));
  check('  carries the source so the headline can be broken down', sources.size >= 2 && !sources.has(undefined), [...sources].join(','));
  // Distinct defects vs instances. Every bug_found must say which it is, or a distinct count read
  // off this stream is silently inflated — one defect hit five times looks like five defects, and
  // that is the number that would end up in a deck. Measured on a real app: 7 events, 3 defects.
  check('  every bug says whether it is a REPEAT of one already counted', bugs.every((b) => typeof b.properties.bug_repeat === 'boolean'));
  check('  the first sighting of a kind is not a repeat', bugs.every((b) => b.properties.bug_repeat === false));
  // Scoped to the bug_* fields and using markers that cannot collide with hex. The first version
  // stringified the WHOLE event and looked for 'e3', which matches a sessionId or a fingerprint by
  // chance — a leak check that cries wolf trains you to ignore leak failures, which is precisely
  // when you would miss a real one.
  const bugFields = JSON.stringify(bugs.map((b) => Object.fromEntries(
    Object.entries(b.properties).filter(([k]) => k.startsWith('bug_')),
  )));
  check('  leaks no element, selector or URL from the app it was found in',
    !bugFields.includes('SECRETMARKER') && !bugFields.includes('acme.internal') && !bugFields.includes('checkout'));
  // An ALLOWLIST, not a denylist: every bug_* field that leaves this machine is named here, so
  // adding one is a deliberate act reviewed against "does this describe the user's app?". Failing
  // here on a new field is the guard doing its job. `bug_repeat` is a boolean about OUR counting —
  // whether this kind was already seen this session — and says nothing about the app it was found in.
  // `bug_attribution` is ALWAYS present and is an owner, never a description of the app: `app` |
  // `request` | `reticle` | `unclassified`, from a closed list.
  const BUG_FIELDS = new Set(['bug_falseGreen', 'bug_fingerprint', 'bug_kind', 'bug_repeat', 'bug_source', 'bug_tool', 'bug_attribution']);
  check('  carries only the classified kind, source, dedup flag and attribution', bugs.every((b) =>
    Object.keys(b.properties).filter((k) => k.startsWith('bug_')).every((k) => BUG_FIELDS.has(k))));
  // Whose fault it was. It shipped twice and was wrong both times — across two real drives every
  // `app` was a misattribution, so a session would have published defects against a customer's
  // product that did not exist. It is back with two rules: always PRESENT (absence and "we looked
  // and could not tell" are different facts), and `app` only where the app positively did something,
  // reusing core's own absence-derived line. Every historical misattribution was an absence-derived
  // kind, so these pin the rule that produces none of them.
  check(
    '  every defect names an owner, never an absent field',
    bugs.every((b) => typeof b.properties.bug_attribution === 'string'),
    bugs.map((b) => b.properties.bug_attribution).join(','),
  );
  check(
    '  a positively-observed contradiction is attributed to the app',
    bugs.some((b) => b.properties.bug_kind === 'signal-contradicted' && b.properties.bug_attribution === 'app'),
  );
  check(
    '  a single-channel console error is NOT blamed on the app',
    bugs.some((b) => b.properties.bug_kind === 'console-error' && b.properties.bug_attribution === 'unclassified'),
  );
  check(
    '  and the defects are still counted',
    bugs.some((b) => b.properties.bug_kind === 'signal-contradicted') &&
      bugs.some((b) => b.properties.bug_kind === 'console-error'),
  );
  check(
    '  carries a fingerprint for cross-session dedup',
    bugs.every((b) => /^[0-9a-f]{8}$/.test(b.properties.bug_fingerprint ?? '')),
  );
}

// ── 4a-bis. Refusals — why the biggest cohort in the funnel goes quiet ───────
// The refusal path computed a precise diagnosis, handed it to the agent as prose and threw it away,
// so a user who hit a wall on their first call emitted nothing at all. A kind-only assertion cannot
// see an empty payload (see the outage note below), so these assert the FIELDS.
const refusingTool = { name: 'reticle_query', description: '', inputSchema: {}, handler: async () => {
  throw new Error('no browser session connected');
} };
for (const _ of [0, 1]) {
  try { await runTool(refusingTool, deps, { by: 'testid', value: 'submit' }); } catch {}
}
// A tool that refuses by RETURNING `{ error }` — this codebase's other refusal convention, and half
// the surface. Reading only the throw path would measure half the wall and call it the whole of it.
const returningRefusal = { name: 'reticle_baseline', description: '', inputSchema: {}, handler: async () => ({
  error: "no baseline named 'checkout-v3'",
}) };
await runTool(returningRefusal, deps, { action: 'diff', name: 'checkout-v3' });
await settle();
{
  const rs = find('tool_refused');
  check('tool_refused fires when a call cannot be served', rs.length === 3, `got ${rs.length}`);
  check('  names the tool that refused', rs[0]?.properties.refusal_tool === 'reticle_query', String(rs[0]?.properties.refusal_tool));
  check('  says WHY, from the closed list', rs[0]?.properties.refusal_reason === 'no_session', String(rs[0]?.properties.refusal_reason));
  check('  the first refusal is not a retry', rs[0]?.properties.refusal_retried === false);
  check('  the same tool called straight after IS flagged as a retry', rs[1]?.properties.refusal_retried === true);
  check('  a refusal RETURNED rather than thrown is counted too', rs[2]?.properties.refusal_tool === 'reticle_baseline', String(rs[2]?.properties.refusal_tool));
  check('  and classified by what was missing, not lumped in with no_session', rs[2]?.properties.refusal_reason === 'no_match', String(rs[2]?.properties.refusal_reason));
  // The refusal message interpolates whatever the caller asked for — a baseline name, a selector, a
  // testid. Only the tool NAME and the bucket may leave; the message itself never does.
  check('  leaks no argument from the refused call', !JSON.stringify(rs).includes('checkout-v3') && !JSON.stringify(rs).includes('submit'));
}

// ── 4b. SDK failures from the in-page half, arriving over the bridge ──────────
metrics.recordSdkFailure('network_observer', "cannot patch fetch on 'https://acme.internal/app'");
metrics.recordSdkFailure('network_observer', "cannot patch fetch on 'https://other.internal/x'");
metrics.recordSdkFailure('dom_observer', 'MutationObserver is not defined');

// ── 4c. Connection outcomes: attempts AND failures, with a classified cause ───
metrics.recordConnectAttempt('launched')();
const poolFail = metrics.recordConnectAttempt('pooled');
poolFail(classifyConnectFailure(new Error("Executable doesn't exist at /ms-playwright/chromium/headless_shell")));
metrics.recordConnectAttempt('attached')(classifyConnectFailure(new Error('connect ECONNREFUSED 127.0.0.1:9222')));
{
  check('classifies a missing Chromium as a docs problem, not "other"',
    classifyConnectFailure(new Error("Executable doesn't exist")) === 'chromium_missing');
  check('  classifies a refused CDP endpoint as a config problem',
    classifyConnectFailure(new Error('connect ECONNREFUSED 127.0.0.1:9222')) === 'cdp_unreachable');
  check('  falls back to `other` rather than guessing a cause',
    classifyConnectFailure(new Error('something nobody has seen before')) === 'other');
}

// ── 4d. MCP client attached — "running" vs "actually being used" ──────────────
markDaemonStart(Date.now() - 5000);
reportMcpConnected('claude-code');
reportMcpConnected('claude-code');
await settle();
{
  const cs = find('mcp_client_connected');
  check('mcp_client_connected fires when an agent actually attaches', cs.length === 2, `got ${cs.length}`);
  check('  first attach is not a reconnect', cs[0]?.properties.connection_reconnect === false);
  check('  a re-attach IS flagged, so churn is distinguishable from usage', cs[1]?.properties.connection_reconnect === true);
  check('  carries how long the daemon sat before anyone used it', (cs[0]?.properties.connection_daemonAgeMs ?? 0) >= 5000);
}

// ── 4d-bis. MCP outage — the transport-stability metric ──────────────────────
// The event fired for months with an EMPTY payload: `emit()` builds its event from an explicit
// allow-list of keys and `outage` was not on it, so two deliberately different outages produced
// byte-identical events. It typechecked, it sent, and the data is permanently gone. Against a
// standing "MCP must never go down" mandate, the metric measuring it reported a bare count with no
// cause and no recovery signal. A kind-only assertion is what let that pass — so these assert the
// FIELDS.
reportMcpOutage(OutageStage.FIRST, { reason: 'sse_ended', attempts: 3 });
reportMcpOutage(OutageStage.BUDGET_SPENT, { reason: 'connect_error', attempts: 12 });
await settle();
{
  const os_ = find('mcp_connection_lost');
  check('mcp_connection_lost fires when the agent loses its tools', os_.length === 2, `got ${os_.length}`);
  const first = os_.find((e) => e.properties.outage_stage === 'first');
  const spent = os_.find((e) => e.properties.outage_stage === 'budget_spent');
  check('  the two stages are distinguishable — "did it come back" depends on it', first !== undefined && spent !== undefined);
  check('  carries WHY the stream went away', first?.properties.outage_reason === 'sse_ended', String(first?.properties.outage_reason));
  check('  carries how many reconnects had been tried', spent?.properties.outage_attempts === 12, String(spent?.properties.outage_attempts));
  check('  two DIFFERENT outages are not byte-identical', JSON.stringify(first) !== JSON.stringify(spent));
}
{
  // The reason is a closed vocabulary: the proxy's own strings are free text feeding a log, and an
  // unbounded value must never reach the wire.
  resetOutageReporting();
  reportMcpOutage(OutageStage.FIRST, { reason: 'socket hang up talking to 10.0.0.7', attempts: 1 });
  await settle();
  const last = find('mcp_connection_lost').at(-1);
  check('  an unrecognised cause reports `other`, never the raw string', last?.properties.outage_reason === 'other', String(last?.properties.outage_reason));
  check('  and leaks nothing from it', !JSON.stringify(last).includes('10.0.0.7'));
}

// ── 4e. Onboarding funnel ─────────────────────────────────────────────────────
reportInitOutcome({ ok: false, reason: InitFailure.DEPENDENCY_INSTALL, stack: 'next', mcpRegistered: false });
await settle();
{
  const i = find('init_completed')[0];
  check('init_completed fires — the onboarding funnel had NO instrumentation', i !== undefined);
  check('  distinguishes a dependency failure from an MCP-registration one', i?.properties.init_reason === 'dependency_install');
  check('  carries the stack that failed to set up', i?.properties.init_stack === 'next');
}

// ── 5. Crash analytics ────────────────────────────────────────────────────────
// Drive a known tool immediately before the crash so the "trigger point" assertion is about the
// mechanism rather than about whatever happened to run last in this file.
await runTool(actTool, deps, { ref: 'e9', action: 'click' });
const handlers = {};
installDaemonResilience({ on: (ev, fn) => (handlers[ev] = fn) }, () => {}, () => {});
{
  const err = new TypeError("cannot read 'ref' of undefined");
  err.stack = [
    "TypeError: cannot read 'ref' of undefined",
    '    at resolveAnchor (/home/u/node_modules/@reticlehq/server/dist/tools/act-tools.js:142:19)',
    '    at Object.runTool (/home/u/node_modules/@reticlehq/server/dist/tools/invoke-tool.js:88:3)',
    '    at doCheckout (/Users/ada/secret-app/src/checkout.tsx:42:9)',
    '    at node:internal/process/task_queues:95:5',
  ].join('\n');
  handlers['unhandledRejection']?.(err);
}
handlers['uncaughtException']?.(new RangeError('index out of range'));
await settle();
{
  const cs = find('runtime_crashed');
  check('runtime_crashed fires for both crash kinds', cs.length === 2, `got ${cs.length}`);
  check('  distinguishes rejection from exception', new Set(cs.map((e) => e.properties.crash_kind)).size === 2);
  check('  carries the error TYPE', cs.some((e) => e.properties.crash_errorType === 'TypeError'));
  check('  carries a fingerprint', cs.every((e) => /^[0-9a-f]{12}$/.test(e.properties.crash_fingerprint ?? '')));
  const blob = JSON.stringify(cs);
  check('  leaks NO raw message text', !blob.includes('cannot read x'));
  check('  leaks NO user path or app file', !blob.includes('/Users/ada') && !blob.includes('Checkout.tsx'));
  // The detail that makes a fingerprint diagnosable rather than merely rankable.
  const deep = cs.find((e) => e.properties.crash_errorType === 'TypeError');
  check('  carries a READABLE skeleton message', typeof deep?.properties.crash_message === 'string' && deep.properties.crash_message.includes('*'));
  check('  carries OUR OWN frames with function@file:line', JSON.stringify(deep?.properties.crash_frames ?? []).includes('act-tools.js'));
  check('  frames name the FUNCTION, not just the file', JSON.stringify(deep?.properties.crash_frames ?? []).includes('@'));
  check('  frames exclude the user\'s own app frames', !JSON.stringify(deep?.properties.crash_frames ?? []).includes('checkout'));
  check('  carries the tool in flight (the trigger point)', deep?.properties.crash_tool === 'reticle_act', String(deep?.properties.crash_tool));
  check('  carries the agent\'s approach run (breadcrumb)', JSON.stringify(deep?.properties.crash_breadcrumb ?? []).includes('reticle_assert'));
  check('  carries node version + arch', typeof deep?.properties.crash_nodeVersion === 'string' && typeof deep?.properties.crash_arch === 'string');
  check('  attributes the crash to the agent', deep?.properties.actor === 'agent');
  // "Out of memory" and "our bug" produce identical stack traces; this is what separates them.
  check('  carries the machine state at the moment of the crash', typeof deep?.properties.crash_machine === 'object' && deep.properties.crash_machine !== null);
  check('  machine snapshot has real memory numbers', (deep?.properties.crash_machine?.totalMemMb ?? 0) > 0);
}

// ── 6. Feedback (agent path, through the real MCP tool) ───────────────────────
const feedbackTool = TOOLS.find((t) => t.name === 'reticle_feedback');
check('reticle_feedback tool is registered', feedbackTool !== undefined);
const receipt = await runTool(feedbackTool, deps, {
  kind: 'gap',
  text: 'reticle_network missed the POST. contact ada@example.com, token sk-abcdefghijklmnopqrstuvwx',
  trace: 'called reticle_network at /Users/ada/app',
});
await settle();
{
  const f = find('feedback_submitted')[0];
  check('feedback_submitted fires from the agent tool', f !== undefined);
  // ACCEPTED, not sent. The agent path no longer waits for the POST — a ~340ms round-trip mid-task
  // is the product blocking the user's work to talk about itself — so `sent` (confirmed delivery)
  // is deliberately false here and `accepted` (validated, redacted, queued) is the field that
  // carries the promise. `sent` still means delivery on the HUMAN path below, which does wait.
  check('  receipt reports it was accepted', receipt?.accepted === true, JSON.stringify(receipt?.reason ?? ''));
  check(
    '  and does NOT claim delivery it has not confirmed',
    receipt?.sent === false,
    `sent=${String(receipt?.sent)}`,
  );
  check('  carries the kind', f?.properties.feedback_kind === 'gap');
  check('  source is the agent', f?.properties.feedback_source === 'agent');
  check('  carries detected stack context', f?.properties.feedback_stack === 'next', f?.properties.feedback_stack);
  check('  carries the stack MAJOR', f?.properties.feedback_stackMajor === 15);
  const blob = JSON.stringify(f);
  check('  REDACTED the email', !blob.includes('ada@example.com'));
  check('  REDACTED the api key', !blob.includes('sk-abcdefghijklmnopqrstuvwx'));
  check('  REDACTED the home path', !blob.includes('/Users/ada'));
  check('  redaction is reported back to the caller', (receipt?.redacted ?? []).length >= 2, JSON.stringify(receipt?.redacted));
}

// ── 6b. A feature request from an agent — the roadmap channel ────────────────
const featureReceipt = await runTool(feedbackTool, deps, {
  kind: 'feature_request',
  text: 'A way to assert that NO request fired during an action.',
  need: 'Verifying a debounced search does not call the API on every keystroke.',
  impact: 'Removes a 3-call workaround from every debounce check.',
  currentApproach: 'Diffing reticle_network counts by hand, token sk-abcdefghijklmnopqrstuvwx',
  model: 'claude-opus-4',
});
await settle();
{
  const f = find('feedback_submitted').find((e) => e.properties.feedback_kind === 'feature_request');
  check('an agent can REQUEST a feature, not only report failures', f !== undefined);
  check('  carries the GOAL behind the request', f?.properties.feedback_need?.includes('debounced'));
  check('  carries the workaround — the most useful field in the report', typeof f?.properties.feedback_currentApproach === 'string');
  check('  carries the self-reported MODEL, which MCP cannot tell us', f?.properties.feedback_model === 'claude-opus-4');
  // The structured fields are free text and bypassed redaction when they were first added.
  check('  REDACTS the structured fields too, not just text/trace', !JSON.stringify(f).includes('sk-abcdefghijklmnopqrstuvwx'));
  // The word "token" precedes the key, so the credential-assignment rule claims it before the
  // vendor-key rule sees it. Either is a correct redaction — assert that SOMETHING fired rather than
  // pinning which rule won, or this becomes a brittle test of rule ordering.
  check('  redaction is reported back for the structured field', (featureReceipt?.redacted ?? []).length > 0, JSON.stringify(featureReceipt?.redacted));
}

// ── 7. Identify (opt-in) ──────────────────────────────────────────────────────
await submitIdentity({ context: 'company', company: 'Acme Corp', email: 'dev@acme.com' });
await settle();
{
  const i = find('identified')[0];
  check('identified fires only from an explicit call', i !== undefined);
  check('  carries the self-declared context', i?.properties.identity_context === 'company');
}

// ── 8. Human feedback path ────────────────────────────────────────────────────
const human = await submitFeedback({ source: 'human', kind: 'experience', text: 'worked well', rating: 5 });
await settle();
{
  check('human feedback sends', human.sent === true, human.reason ?? '');
  const f = find('feedback_submitted').find((e) => e.properties.feedback_source === 'human');
  check('  carries the rating', f?.properties.feedback_rating === 5);
}

// ── 8b. Version changed (update + rollback) ───────────────────────────────────
await reportVersionChange('2.2.1', '2.3.0', 'update');
await reportVersionChange('2.3.0', '2.2.1', 'rollback');
await settle();
{
  const vs = find('version_changed');
  check('version_changed fires for update and rollback', vs.length === 2, `got ${vs.length}`);
  const up = vs.find((e) => e.properties.version_direction === 'update');
  check('  carries from -> to', up?.properties.version_from === '2.2.1' && up?.properties.version_to === '2.3.0');
  check('  a rollback is distinguishable from an update', vs.some((e) => e.properties.version_direction === 'rollback'));
}

// ── 8c. First-ever run, in a child with a pristine HOME ───────────────────────
{
  const { execFileSync } = await import('node:child_process');
  const fakeHome = mkdtempSync(join(tmpdir(), 'reticle-home-'));
  const script = `
    const m = await import('${DIST}/telemetry/cli-telemetry.js');
    m.reportCliRun(['version']);
    await new Promise(r => setTimeout(r, 1500));
  `;
  // Count BEFORE, and assert the DELTA. The absolute count is a statement about the machine, not
  // about the product: a developer's box already has `~/.reticle`, so only this child fires the
  // event and the total is 1 — but a fresh CI runner does not, so everything earlier in this spec
  // fires it too and the total was 3. The contract is "a machine that has never run Reticle emits
  // it exactly once", which is a delta.
  const installedBefore = find('reticle_installed').length;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      cwd: root,
      timeout: 20000,
    });
  } catch {}
  await settle();
  const fromPristineHome = find('reticle_installed').length - installedBefore;
  check('reticle_installed fires on a machine that has never run Reticle', fromPristineHome === 1, `got ${fromPristineHome} from the pristine HOME`);
  rmSync(fakeHome, { recursive: true, force: true });
}

// ── 9. Daemon shutdown → the rich session summary ─────────────────────────────
// NO settle() before the assertion, deliberately. The bug this guards against was a fire-and-forget
// emit followed immediately by process.exit(0), which killed the POST every time. Any wait here would
// hide it, because a fire-and-forget send DOES land given ~700ms — it just never gets them. Asserting
// the event has already ARRIVED the instant shutdown() resolves is the real contract: awaiting
// shutdown must be sufficient, with no grace period, because in production there is none.
// NO settle() before the assertion, deliberately. The bug this guards against was a fire-and-forget
// emit followed immediately by process.exit(0), which killed the POST every time. Any wait here would
// hide it, because a fire-and-forget send DOES land given ~700ms — it just never gets them. Asserting
// the event has already ARRIVED the instant shutdown() resolves is the real contract: awaiting
// shutdown must be sufficient, with no grace period, because in production there is none.
// With a REASON, as cli.ts's shutdown path passes it. A designed idle exit and a real failure
// must not be the same row: 299 of 321 measured 'outages' were the daemon retiring itself.
await daemon.shutdown('idle');
{
  const s = find('daemon_stopped')[0];
  const arrived = s !== undefined;
  check('daemon_stopped has ARRIVED by the time shutdown() resolves (no grace period)', arrived);
  // Every downstream check is gated on arrival. Without this the whole spec dies on a TypeError the
  // moment the event is missing, which reports a crash instead of naming the thing that broke — and
  // the thing that broke is exactly the failure this file was written to catch.
  const p = s?.properties ?? {};
  check('  marked final', arrived && p.session_final === true);
  check('  counted tool calls', arrived && p.session_toolCalls === 12, String(p.session_toolCalls));
  check('  histogram by tool name', arrived && JSON.stringify(p.session_toolCounts ?? {}).includes('reticle_act'));
  check('  counted verifications', arrived && p.session_verifications === 4, String(p.session_verifications));
  check('  counted tool errors', arrived && p.session_toolErrors === 3, String(p.session_toolErrors));
  const errors = p.session_errors ?? [];
  check('  grouped 2 same-shape errors into 1 fingerprint', arrived && errors.length === 2, `${errors.length} shapes`);
  check('  errors leak no flow name', !JSON.stringify(errors).includes('checkout-v3'));
  const baselineError = errors.find((e) => e.tool === 'reticle_baseline');
  check('  error carries a READABLE skeleton, not just a hash', baselineError?.message === 'no baseline named *', String(baselineError?.message));
  check('  error names the tool that produced it', baselineError !== undefined);
  check('  error carries its count', baselineError?.count === 2, String(baselineError?.count));
  check('  reports WHICH tools the agent guessed at, not just how many', arrived && (p.session_unknownTools === undefined || 'object' === typeof p.session_unknownTools), String(p.session_unknownTools));
  check('  reports which tool surface the agent saw', arrived && (p.session_surface === undefined || 'string' === typeof p.session_surface), String(p.session_surface));
  check('  says what state the agent work ended in', arrived && 'string' === typeof p.session_endReason, String(p.session_endReason));
  // The headline metric, as a field rather than a subtraction. Every other verification number here
  // is windowed, so a reader who summed the wrong one answered a different question.
  check('  says outright whether the session ever produced a verdict', arrived && p.session_endedWithVerdict === true, String(p.session_endedWithVerdict));
  check('  buckets tool errors by whose defect they are', arrived && 'object' === typeof p.session_errorClasses, JSON.stringify(p.session_errorClasses));
  // The 2.6.0 fields, asserted HERE because this is the only place that proves they reach the wire.
  // Telemetry fails silently: a field dropped from the emit allow-list throws nothing and reddens no
  // unit test, and the data is simply, permanently absent.
  check('  reports whether an app ever connected (zero is the finding)', arrived && typeof p.session_appConnects === 'number', String(p.session_appConnects));
  check('  reports WHY the daemon exited, so a designed idle exit is not an outage', arrived && p.session_exit === 'idle', String(p.session_exit));
  const params = p.session_toolParams ?? {};
  check('  recorded tool PARAM names', arrived && JSON.stringify(params).includes('ref'));
  check('  recorded a safe enum VALUE', arrived && JSON.stringify(params).includes('action:type'));
  check('  leaked NO param value', !JSON.stringify(params).includes('hunter2'));
  // Timing — the headline "how much time does verification actually cost" numbers.
  check('  timed each tool (total + worst call)', arrived && typeof p.session_toolTiming === 'object');
  check('  reports total busy time inside tool calls', arrived && typeof p.session_busyMs === 'number');
  check('  reports peak concurrent tool calls', arrived && typeof p.session_peakConcurrentTools === 'number');
  // Connections: attempts and failures, not a bare success count.
  const conns = p.session_connections ?? {};
  check('  connection attempts AND successes recorded', conns['launched']?.attempts === 1 && conns['launched']?.successes === 1);
  check('  a FAILED connection is visible, with its cause', conns['pooled']?.failures?.chromium_missing === 1, JSON.stringify(conns['pooled']));
  check('  a refused CDP attach is classified, not lumped into `other`', conns['attached']?.failures?.cdp_unreachable === 1, JSON.stringify(conns['attached']));
  check('  machine state captured at session end', arrived && (p.session_machine?.cpuCount ?? 0) > 0);
  // The outcome number, rolled up and broken down.
  check('  session counts the bugs found', arrived && p.session_bugsFound === 4, String(p.session_bugsFound));
  check('  and keeps them broken down by kind', JSON.stringify(p.session_bugKinds ?? {}).includes('signal-contradicted'));
  // Reticle's overhead vs the app's own slowness — opposite fixes, previously indistinguishable.
  check('  reports browser-leg latency separately from total busy time', arrived && typeof p.session_browserMs === 'number');
  // The in-page half of Reticle had no error reporting at all until now.
  const sdk = p.session_sdkErrors ?? [];
  check('  counted SDK failures from the browser', arrived && p.session_sdkFailures === 3, String(p.session_sdkFailures));
  check('  grouped SDK failures by shape', arrived && sdk.length === 2, `${sdk.length} shapes`);
  check('  SDK failure names the module that reported it', sdk.some((e) => e.tool === 'network_observer'));
  check('  SDK failure carries a readable skeleton', sdk.some((e) => e.message.includes('cannot patch fetch')));
  check('  SDK failure leaks NO app URL', !JSON.stringify(sdk).includes('acme.internal'));
  check('  SDK failures kept separate from tool errors', arrived && (p.session_errors ?? []).every((e) => e.tool !== 'network_observer'));
}

// ── 10. Project profile (deliberately deferred 5s off the daemon boot path) ───
await new Promise((r) => setTimeout(r, 6000));
// ── ────────────────────────────────────────────────────
{
  const p = find('project_profiled')[0]?.properties;
  check('project_profiled fires', p !== undefined, '(deferred 5s after daemon start)');
  if (p !== undefined) {
    check('  detected the stack', p.project_stack === 'next', p.project_stack);
    check('  detected git state', p.project_git === 'remote', p.project_git);
    check('  detected the forge', p.project_forge === 'github', p.project_forge);
    check('  counted saved flows', p.project_flowCount === 1, String(p.project_flowCount));
    check('  computed featureDepth', typeof p.project_featureDepth === 'number');
  }
}

// ── the session key, checked once EVERY event has been emitted ────────────────
// Placed last on purpose: run in section 1b it saw only CLI events, which deliberately carry no
// sessionId, so it compared an empty set and passed for the wrong reason.
{
  const scoped = captured.filter((e) => SESSION_SCOPED_EVENTS.has(e.event));
  const ids = new Set(scoped.map((e) => e.properties.sessionId));
  check('all events from one daemon share ONE sessionId', ids.size === 1, `${ids.size} distinct across ${scoped.length} events`);
  check('  also sent as PostHog\'s own $session_id, so its session tooling works', scoped.every((e) => e.properties.$session_id === e.properties.sessionId));
  const unscoped = captured.filter((e) => !SESSION_SCOPED_EVENTS.has(e.event));
  check('  and no one-shot event invents one', unscoped.every((e) => e.properties.sessionId === undefined), unscoped.map((e) => e.event).join(','));
}

// ── report ────────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) console.log(`${r.ok ? ' PASS' : ' FAIL'}  ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`events captured: ${JSON.stringify(Object.fromEntries(Object.entries(captured.reduce((a, e) => ({ ...a, [e.event]: (a[e.event] ?? 0) + 1 }), {}))))}`);
rmSync(root, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
