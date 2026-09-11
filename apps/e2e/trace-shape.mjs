// Assert the SHAPE of a RETICLE_TRACE=1 run. Pure over lines, so it can be pointed at any daemon log.
//
// `runTool` opens one `tool.handler` root span per call and every stage underneath inherits its
// callId through AsyncLocalStorage. That structure encodes invariants nothing currently checks —
// the trace is produced on every traced run and then discarded.
//
// The invariant that matters is the HANG signature. A span is emitted when it ENDS, so a call that
// hangs emits nothing at all; what it leaves behind is a completed child with no completed parent.
// `bindSpanContext` exists because 25 of those appeared on one healthy run, and a signature that
// fires 25 times on a healthy run cannot locate the next real hang.
//
// Self-check: `node apps/e2e/trace-shape.mjs --self-check`
// Against a real log: `node apps/e2e/trace-shape.mjs ~/.reticle/daemon-4400.log`

/** The `event` value every trace line carries — see packages/server/src/trace.ts. */
const TRACE_EVENT = 'trace';
/** The root span `runTool` opens for every tool call, on both dispatch paths. */
const TOOL_HANDLER_SPAN = 'tool.handler';
/** A round-trip to the page. Normally nested inside a tool call. */
const BROWSER_COMMAND_SPAN = 'browser.command';

/**
 * Browser commands the SERVER initiates, which correctly have no `tool.handler` above them.
 *
 * An allow-list rather than "ignore all parentless browser commands", because the difference between
 * the two is the whole diagnostic. `flows` is the HUD's flow list being pushed — measured 7 times
 * across a 433-call run, all `ok`, all under 30ms. A command that appears here without being declared
 * is either a new server-initiated push (declare it) or the hang signature (fix it), and collapsing
 * those two into silence is how the signature stopped working the first time.
 */
export const SERVER_INITIATED_COMMANDS = new Set(['flows']);

export const Violation = {
  MULTI_ROOT: 'multi-root',
  MISSING_ROOT: 'missing-root',
  UNDECLARED_ORPHAN: 'undeclared-orphan',
  FAILURE_WITHOUT_ERROR: 'failure-without-error',
};

/** Parse the trace lines out of a daemon log. Non-JSON and non-trace lines are skipped, not fatal. */
export function parseTrace(text) {
  const spans = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (row.event === TRACE_EVENT) spans.push(row);
  }
  return spans;
}

/**
 * Group by callId and report every way the tree is malformed.
 *
 * Returns `{ calls, spans, violations }` so a caller can report the scale alongside the faults — "0
 * violations" over 3 spans is not the same statement as "0 violations" over 494, and a shape check
 * that silently ran on an empty log is the exact rot this repo has been bitten by before.
 */
export function analyzeTrace(spans) {
  const byCall = new Map();
  for (const span of spans) {
    const list = byCall.get(span.callId) ?? [];
    list.push(span);
    byCall.set(span.callId, list);
  }

  const violations = [];
  for (const [callId, list] of byCall) {
    const roots = list.filter((s) => s.depth === 0);

    // Two roots under one callId means two calls were merged, and every duration read off that
    // callId afterwards belongs to neither.
    if (roots.length > 1) {
      violations.push({
        kind: Violation.MULTI_ROOT,
        callId,
        detail: `${String(roots.length)} spans at depth 0: ${roots.map((s) => s.span).join(', ')}`,
      });
    }

    // A nested span whose root never ended. This is the hang signature.
    if (roots.length === 0) {
      violations.push({
        kind: Violation.MISSING_ROOT,
        callId,
        detail:
          `nested spans (${list.map((s) => `${s.span}@${String(s.depth)}`).join(', ')}) with no ` +
          'depth-0 span — the parent never completed',
      });
    }

    // A parentless browser command that nobody declared as server-initiated.
    const parentless = list.filter(
      (s) => s.span === BROWSER_COMMAND_SPAN && s.depth === 0 && !hasToolHandler(list),
    );
    for (const span of parentless) {
      if (SERVER_INITIATED_COMMANDS.has(span.command)) continue;
      violations.push({
        kind: Violation.UNDECLARED_ORPHAN,
        callId,
        detail:
          `browser.command '${String(span.command)}' ran with no tool.handler above it. Either it ` +
          'is server-initiated (add it to SERVER_INITIATED_COMMANDS) or a tool call hung.',
      });
    }
  }

  // A stage that threw must say what threw. Without it the trace shows a call that entered a stage
  // and left it unsuccessfully, with nothing to act on.
  for (const span of spans) {
    if (span.ok === false && (span.error === undefined || span.error === '')) {
      violations.push({
        kind: Violation.FAILURE_WITHOUT_ERROR,
        callId: span.callId,
        detail: `span '${String(span.span)}' reported ok:false with no error field`,
      });
    }
  }

  return { calls: byCall.size, spans: spans.length, violations };
}

function hasToolHandler(list) {
  return list.some((s) => s.span === TOOL_HANDLER_SPAN);
}

/** One line per violation, plus the scale it was measured over. */
export function formatReport({ calls, spans, violations }) {
  const head = `${String(spans)} spans across ${String(calls)} callIds`;
  if (violations.length === 0) return `trace shape ok — ${head}`;
  return [`trace shape: ${String(violations.length)} violation(s) over ${head}`]
    .concat(violations.map((v) => `  [${v.kind}] ${v.callId}: ${v.detail}`))
    .join('\n');
}

// ── self-check ────────────────────────────────────────────────────────────────────────────────
async function selfCheck() {
  const assert = await import('node:assert/strict');
  const line = (o) => JSON.stringify({ t: '2026-01-01T00:00:00.000Z', event: 'trace', ...o });

  const healthy = [
    line({ span: 'tool.handler', depth: 0, callId: 'c1', ok: true, tool: 'reticle_act' }),
    line({ span: 'browser.command', depth: 1, callId: 'c1', ok: true, command: 'click' }),
    // The real, correct parentless case: the HUD's flow push.
    line({ span: 'browser.command', depth: 0, callId: 'c2', ok: true, command: 'flows' }),
    'not json at all',
    JSON.stringify({ event: 'session_connected', sessionId: 's1' }),
  ].join('\n');

  const ok = analyzeTrace(parseTrace(healthy));
  assert.deepEqual(ok.violations, [], `a healthy trace must be silent, got: ${formatReport(ok)}`);
  assert.equal(ok.calls, 2, 'non-trace and non-JSON lines must not become calls');
  assert.equal(ok.spans, 3);

  const hung = analyzeTrace(
    parseTrace(line({ span: 'browser.command', depth: 1, callId: 'c9', ok: true, command: 'snapshot' })),
  );
  assert.equal(hung.violations[0]?.kind, Violation.MISSING_ROOT, 'the hang signature must fire');

  const undeclared = analyzeTrace(
    parseTrace(line({ span: 'browser.command', depth: 0, callId: 'c8', ok: true, command: 'presenter' })),
  );
  assert.equal(
    undeclared.violations[0]?.kind,
    Violation.UNDECLARED_ORPHAN,
    'an undeclared parentless browser command must fire',
  );

  const merged = analyzeTrace(
    parseTrace(
      [
        line({ span: 'tool.handler', depth: 0, callId: 'c7', ok: true }),
        line({ span: 'tool.handler', depth: 0, callId: 'c7', ok: true }),
      ].join('\n'),
    ),
  );
  assert.equal(merged.violations[0]?.kind, Violation.MULTI_ROOT);

  const silentFailure = analyzeTrace(
    parseTrace(line({ span: 'tool.handler', depth: 0, callId: 'c6', ok: false })),
  );
  assert.equal(silentFailure.violations[0]?.kind, Violation.FAILURE_WITHOUT_ERROR);

  console.log('trace-shape self-check: ok (healthy silent; hang, orphan, merge and silent failure all fire)');
}

if (process.argv.includes('--self-check')) {
  await selfCheck();
} else if (process.argv[2] !== undefined) {
  const { readFileSync } = await import('node:fs');
  const report = analyzeTrace(parseTrace(readFileSync(process.argv[2], 'utf8')));
  console.log(formatReport(report));
  if (report.violations.length > 0) process.exit(1);
}
