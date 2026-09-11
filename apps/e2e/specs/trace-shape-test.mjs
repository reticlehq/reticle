// The trace is produced on every RETICLE_TRACE=1 run and then thrown away. This reads it.
//
// `runTool` opens one `tool.handler` root span per call and every stage underneath inherits its
// callId. That structure carries invariants no other spec checks, and one of them is the HANG
// signature: a span is emitted when it ENDS, so a call that hangs emits nothing, and what it leaves
// behind is a completed child with no completed parent. `bindSpanContext` was added because 25 of
// those appeared on a single healthy run — and a signature firing 25 times on a healthy run cannot
// locate the next real hang.
//
// Needs no browser and no servers: tool calls that refuse for lack of a session still open their
// root span, which is exactly the structure under test. Owns its own daemon on its own port.
import path from 'node:path';
import { statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { analyzeTrace, parseTrace, formatReport } from '../trace-shape.mjs';
import { freePortSafely } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.TRACE_SHAPE_PORT ?? '4743';
const DAEMON_LOG = path.join(homedir(), '.reticle', `daemon-${PORT}.log`);

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

/** Bytes already in the log. The file survives between runs, and analysing a previous run's spans
 *  would report violations this run did not cause — or, worse, pass on somebody else's clean data. */
function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function readFrom(file, offset) {
  const size = sizeOf(file);
  if (size <= offset) return '';
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

console.log('\n=== TRACE SHAPE: the call tree the daemon emits is well formed ===');

process.chdir(ROOT);
await freePortSafely(Number(PORT));
const before = sizeOf(DAEMON_LOG);

const client = new McpStdioClient('node', ['packages/server/dist/cli.js', 'mcp', '--port', PORT], {
  RETICLE_PORT: PORT,
  RETICLE_TRACE: '1',
  RETICLE_TELEMETRY: '0',
  // The gate owns this daemon for the whole spec — see apps/e2e/harness-rules.md.
  RETICLE_IDLE_SHUTDOWN_MS: '0',
});
await client.start();

const tools = await client.listTools();
chk('the client gets a tool surface', Array.isArray(tools) && tools.length > 0, `${tools?.length ?? 0} tools`);

// A spread of dispatch shapes: a plain read, the meta tool, the escape hatch, and one that REFUSES
// for want of a session. A refusal still opens its root span, and the failure paths are where a
// malformed tree is most likely — `span` emits on throw precisely so a thrown stage is visible.
// `callTool` throws on a refusal, and here a refusal is a WANTED input — with no app running,
// every session-bound tool correctly refuses, and the span it opened on the way is the thing under
// test. Swallowing the throw is the point, not a shortcut.
const drive = async (name, args) => {
  try {
    await client.callTool(name, args);
  } catch {
    /* refusals are expected with no app running; the root span is what matters */
  }
};

await drive('reticle_sessions', {});
await drive('reticle_tools', {});
await drive('reticle_run', { tool: 'reticle_capabilities' });
await drive('reticle_snapshot', {});
await drive('reticle_inspect', { ref: 'e404' });

await client.stop();
await freePortSafely(Number(PORT));

const appended = readFrom(DAEMON_LOG, before);
const spans = parseTrace(appended);
const report = analyzeTrace(spans);

// Ordered first on purpose: a shape check over zero spans passes every assertion below it while
// proving nothing, which is the exact way a gate rots without anyone noticing.
chk(
  'the run actually produced a trace',
  report.spans > 0,
  report.spans > 0 ? `${report.spans} spans across ${report.calls} callIds` : `nothing in ${DAEMON_LOG}`,
);

const roots = spans.filter((s) => s.span === 'tool.handler' && s.depth === 0);
chk('every tool call opened a root span', roots.length >= 5, `${roots.length} tool.handler @ depth 0`);

chk('no call tree is malformed', report.violations.length === 0, formatReport(report));

// Named separately from the count above, because this is the one somebody will read in a failure.
const hangs = report.violations.filter((v) => v.kind === 'missing-root');
chk(
  'no completed child span is missing its parent (the hang signature)',
  hangs.length === 0,
  hangs.map((v) => v.detail).join('; '),
);

console.log(
  `\n${fail === 0 ? '✅ TRACE SHAPE VERIFIED' : '❌ TRACE SHAPE FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
