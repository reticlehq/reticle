// Break the link in NAMED ways and check the agent always gets an answer.
//
// The rest of the battery induces transport faults with SIGKILL. One blunt instrument cannot express
// the failures the proxy's three unanswered-call populations exist to handle: a peer that RESETS
// mid-response, a listener that accepts and never serves, a link that goes slow rather than away, a
// response cut off half-sent. None of those is a dead process.
//
// It is also how a wrong conclusion got filed twice. `lsof -ti tcp:4400 | xargs kill -9` takes the
// MCP proxy with the daemon, so "the link never recovers — 40s, no reply" was measured twice and was
// the harness killing itself both times. A toxic breaks the CONNECTION and never the process, so
// that particular confusion is unreachable here.
//
// The claim under test is the product's, and it is one sentence: whatever happens to the transport,
// every call gets an answer and the stdio server stays alive. A hung call is a hung agent, and an
// exited proxy is a human opening /mcp by hand.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { startFaultProxy, Fault } from '../fault-proxy.mjs';
import { freePortSafely, startOwnedDaemon } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'packages/server/dist/cli.js');
/** The daemon's real port, and the port the MCP proxy is pointed at. The fault sits between them. */
const DAEMON_PORT = Number(process.env.TRANSPORT_FAULTS_DAEMON_PORT ?? '4746');
const LINK_PORT = Number(process.env.TRANSPORT_FAULTS_LINK_PORT ?? '4747');
/** Comfortably past QUEUE_WAIT_MS (20s), so "the proxy answered it itself" is reachable. */
const ANSWER_BUDGET_MS = 32_000;

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

console.log('\n=== TRANSPORT FAULTS: named breakage, and an answer every time ===');
process.chdir(ROOT);
await freePortSafely(DAEMON_PORT);
await freePortSafely(LINK_PORT);

const daemon = await startOwnedDaemon(DAEMON_PORT, { cliPath: CLI, cwd: ROOT });
const link = startFaultProxy({ listenPort: LINK_PORT, targetPort: DAEMON_PORT });
await link.ready;

// The MCP proxy talks to LINK_PORT, believing it is the daemon. Nothing about the daemon is unusual.
const client = new McpStdioClient('node', [CLI, 'mcp', '--port', String(LINK_PORT)], {
  RETICLE_PORT: String(LINK_PORT),
  RETICLE_TELEMETRY: '0',
});
await client.start();

const alive = () => client.proc !== null && client.proc.exitCode === null && !client.proc.killed;

/** Every call must be ANSWERED — a result or a JSON-RPC error. Never a hang. */
async function callAnswered() {
  const started = Date.now();
  try {
    await client.callTool('reticle_sessions', {}, ANSWER_BUDGET_MS);
    return { answered: true, ms: Date.now() - started, how: 'result' };
  } catch (err) {
    const text = String(err);
    // The client throws on a JSON-RPC error too. An error IS an answer; a timeout is not.
    const timedOut = /timed out|timeout/i.test(text);
    return {
      answered: !timedOut,
      ms: Date.now() - started,
      how: timedOut ? 'TIMED OUT' : text.slice(0, 110),
    };
  }
}

// ── the control ────────────────────────────────────────────────────────────────────────────────
// Without this every assertion below could pass on a link that was broken the whole time.
link.set(Fault.NONE);
const healthy = await callAnswered();
chk('a healthy link answers', healthy.answered && healthy.how === 'result', `${healthy.ms}ms`);

// ── reset-peer: the connection is destroyed under an established link ──────────────────────────
link.set(Fault.RESET_PEER);
link.cutAll();
const reset = await callAnswered();
chk('reset-peer is ANSWERED, not hung', reset.answered, `${reset.ms}ms — ${reset.how}`);
chk('  and the MCP server survives it', alive());

// ── blackhole: accepted and never served — a wedged daemon or a foreign squatter ────────────────
link.set(Fault.BLACKHOLE);
link.cutAll();
const black = await callAnswered();
chk('a blackholed link is ANSWERED, not hung', black.answered, `${black.ms}ms — ${black.how}`);
chk('  and the MCP server survives that too', alive());

// ── truncate: a response cut off half-sent, which a healthy-looking stream can still do ─────────
link.set(Fault.TRUNCATE, { limitBytes: 48 });
link.cutAll();
const cut = await callAnswered();
chk('a truncated response is ANSWERED, not hung', cut.answered, `${cut.ms}ms — ${cut.how}`);
chk('  and the MCP server survives that too', alive());

// ── in flight: the population the three above never reach ───────────────────────────────────────
//
// Every fault so far was applied BEFORE the call, so the call was queued and never forwarded, and
// each was answered by the 20s queue timer reading "no daemon could be reached". That is correct,
// and it is one of three populations. The other one that matters is a call that WAS forwarded and
// then lost — where the answer has to say the call did not complete and may be unsafe to repeat,
// and has to arrive quickly, because the agent is holding a write it cannot classify.
//
// LATENCY is what makes this reachable at all: it holds the response open long enough to cut the
// link underneath a call that is genuinely in flight.
link.set(Fault.NONE);
link.cutAll();
await callAnswered(); // re-establish, so the next call is forwarded rather than queued
link.set(Fault.LATENCY, { latencyMs: 4_000 });
const inFlight = callAnswered();
await sleep(600);
link.set(Fault.RESET_PEER);
link.cutAll();
const lost = await inFlight;
chk('a call broken IN FLIGHT is answered', lost.answered, `${lost.ms}ms — ${lost.how}`);
chk(
  '  and faster than the queue timer, because it was forwarded rather than queued',
  lost.answered && lost.ms < 20_000,
  `${lost.ms}ms (the queue timer is 20000ms)`,
);

// ── recovery: the whole point. A transport fault must be survivable, not terminal ───────────────
link.set(Fault.NONE);
link.cutAll();
let recovered = { answered: false, how: 'never tried', ms: 0 };
for (let attempt = 0; attempt < 12; attempt += 1) {
  recovered = await callAnswered();
  if (recovered.answered && recovered.how === 'result') break;
  await sleep(1_000);
}
chk(
  'the link RECOVERS once the fault is lifted',
  recovered.answered && recovered.how === 'result',
  `${recovered.ms}ms — ${recovered.how}`,
);
chk('the MCP server was alive throughout — no /mcp reconnect needed', alive());

await client.stop();
await link.stop();
await daemon.stop();
await freePortSafely(LINK_PORT);

console.log(
  `\n${fail === 0 ? '✅ TRANSPORT FAULTS VERIFIED' : '❌ TRANSPORT FAULTS FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
