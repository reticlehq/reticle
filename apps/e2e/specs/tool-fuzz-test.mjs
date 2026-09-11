// Brute force against the THIRD channel: the agent ↔ tool boundary, one tool at a time.
//
// `tool-surface-sweep-test` calls every shipped tool the way an agent calls it when the agent is
// RIGHT. This calls every shipped tool the way an agent calls it when the agent is WRONG — which is
// the common case, because the caller is a language model guessing at a schema.
//
// The bar is not "it works". Malformed input SHOULD be refused. The bar is the four properties
// whose absence has already produced shipped defects here:
//
//   1. it settles. A tool that hangs on a bad argument is a hung agent.
//   2. the refusal is actionable — it says what was wrong, not just that something was.
//   3. it is not blamed on Reticle. Reticle's own validation error inviting a bug report is the
//      defect the surface sweep already caught once; a fuzz is where it comes back.
//   4. it does not leak internals. A raw stack trace in a tool result is both a bad answer and a
//      disclosure, and it is what an unhandled throw looks like from the outside.
//
// And one security property on top: `__proto__` / `constructor` keys in tool arguments must not
// pollute anything. The arguments arrive as parsed JSON from an untrusted-ish producer.
//
// This spec deliberately does NOT assert the semantics of any individual refusal — that is each
// tool's own test. It asserts the properties that must hold for ALL 48, which is exactly what no
// per-tool test can see.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { waitForSession } from '../wait-for-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.TOOL_FUZZ_PORT ?? '4400';
const APP = process.env.TOOL_FUZZ_APP ?? 'http://localhost:4310/';
// 30s. The property under test is that every call SETTLES, and a hostile argument that
// reaches a browser command waits out that command's own ~5s timeout before answering — measured on
// 13 of the 285 shapes (reticle_state/nulls, reticle_viewport/nulls, reticle_screenshot/huge,
// reticle_replay/huge and others at 5-9s). At 25s a handful of those turned this spec from 90
// seconds into 25+ minutes and stalled the whole battery.
//
// I first set this to 10s and it was too tight: 4 of the 285 shapes did not settle inside it
// (reticle_reconcile/huge-string, reticle_flow_verify/empty, reticle_screenshot/huge-string,
// reticle_replay/huge-string) on a loaded machine — a cap that only just clears the observed worst
// case reddens under load and reports the machine as a defect, which is the exact mistake this
// comment warned about. 15s then left `reticle_flow_verify/empty` short — with no arguments it does
// real project work rather than failing fast. 20s clears every observed shape with room, and still
// keeps the spec well under the 25s that made it stall a whole battery.
//
// Settled at 30s once the reason was measured rather than guessed at a fourth time: this cap exists
// to catch a HANG, not to bound legitimate work. `reticle_flow_verify` with no arguments answers in
// 5ms against no session, and inside the fuzz it verifies every saved flow against a live browser —
// slow is the correct behaviour there, not a defect. Only one shape now comes near the cap, so the
// spec stays fast while a genuine hang (which never answers at all) is still caught.
const CALL_TIMEOUT_MS = 30_000;
/**
 * The second ask, and it is four times the first on purpose.
 *
 * Not a fifth retune of the cap above — the point is the RATIO, not the number. A hang never answers
 * at any budget, so a wider second ask cannot hide one; all it does is stop a legitimately slow shape
 * being reported as hung because a loaded machine ate both attempts at the same size.
 */
const RETRY_TIMEOUT_MS = 120_000;

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

// The phrase Reticle attaches to conditions it does not recognize. A malformed ARGUMENT is a
// condition Reticle authored the validation for, so seeing this marker means it is asking the user
// to file a bug for their own typo.
const FEEDBACK_ASK_MARKER = 'not one Reticle recognizes';
// What an unhandled throw looks like once it has been stringified into a tool result.
const STACK_MARKERS = [/\n\s+at [A-Za-z<]/, /node:internal\//, /\/packages\/server\/dist\//];

console.log('\n=== TOOL FUZZ: every shipped tool, called wrong ===');
process.on('unhandledRejection', () => undefined);
process.chdir(ROOT);

const client = new McpStdioClient(
  'node',
  ['packages/server/dist/cli.js', 'mcp', '--port', PORT, '--drive', APP],
  { RETICLE_PORT: PORT, RETICLE_ADVERTISE_ALL_TOOLS: '1', RETICLE_TELEMETRY: '0' },
);
await client.start();

const tools = await client.listTools();
chk('the full tool surface is advertised', 0 < tools.length, `${tools.length} tools`);


/** A value of the WRONG type for a declared schema type. */
function wrongTypeFor(schema) {
  const declared = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  switch (declared) {
    case 'string':
      return 12345;
    case 'number':
    case 'integer':
      return 'not-a-number';
    case 'boolean':
      return 'yes';
    case 'array':
      return { notAnArray: true };
    case 'object':
      return ['not-an-object'];
    default:
      return null;
  }
}

/**
 * The hostile argument shapes. Each is a plausible mistake a model actually makes, not random
 * noise — random noise mostly re-tests the JSON parser.
 */
function hostileArgs(schema) {
  const props = schema?.properties ?? {};
  const keys = Object.keys(props);
  const firstString = keys.find((k) => 'string' === props[k]?.type);

  const shapes = [
    ['empty', {}],
    ['nulls', Object.fromEntries(keys.map((k) => [k, null]))],
    ['wrong-types', Object.fromEntries(keys.map((k) => [k, wrongTypeFor(props[k])]))],
    ['empty-strings', Object.fromEntries(keys.map((k) => [k, 'string' === props[k]?.type ? '' : props[k]?.type === 'array' ? [] : null]))],
    // Unknown keys plus a prototype-pollution attempt. JSON.parse does not honour `__proto__` as a
    // setter, but anything doing a naive recursive merge downstream would.
    ['junk-keys', { __proto__: { polluted: true }, constructor: { prototype: { polluted: true } }, '': '', 'not-a-real-arg': { deep: { deeper: [1, 2, 3] } } }],
  ];
  if (firstString !== undefined) {
    shapes.push(['huge-string', { [firstString]: 'x'.repeat(100_000) }]);
  }
  return shapes;
}

/**
 * Ask once; if it does not answer in time, ask ONCE more before calling it hung.
 *
 * The cap above has been retuned four times — 10s, 15s, 20s, 30s — each time because a shape did not
 * settle on a loaded machine, and `reticle_replay/huge-string` is named in that history. A fifth bump
 * would be the same mistake: a duration standing in for an invariant, which is exactly what
 * CLAUDE.md forbids, and it fails only under parallel load, i.e. only in CI.
 *
 * The property under test is "every call is eventually ANSWERED". A genuine hang never answers; a
 * loaded runner answers late. One number cannot separate those, but a retry can: answered on the
 * second ask means slow, and never answered twice means hung. Measured while writing this —
 * `reticle_replay` with a 100,000-character argument answers in 2ms on an idle machine, so the CI
 * failure that prompted it was load and nothing else.
 */
async function callRaw(name, args) {
  const first = await callOnce(name, args);
  if (first.settled) return first;
  // The retry is DELIBERATELY more generous than the first ask, and that asymmetry is what makes the
  // retry mean anything. Two asks under the same budget is one number twice: a shape doing real
  // project work — `reticle_flow_verify` with no arguments verifies every saved flow against a live
  // browser — can miss both on a loaded box, and then "never answered twice" reports load as a hang.
  // Observed exactly that, with a stress run saturating the machine beside the battery.
  //
  // A hang never answers at ANY budget, so widening the second ask cannot hide one; it only stops a
  // slow answer being called a hang. The first ask stays short so the common case is still fast.
  const second = await callOnce(name, args, RETRY_TIMEOUT_MS);
  if (second.settled) {
    slow.push(`${name} (answered on retry — the machine was loaded, not the tool)`);
    return second;
  }
  return second;
}

async function callOnce(name, args, budgetMs = CALL_TIMEOUT_MS) {
  try {
    const result = await client.request('tools/call', { name, arguments: args }, budgetMs);
    const text = (result?.content ?? [])
      .filter((c) => 'text' === c.type)
      .map((c) => c.text)
      .join('\n');
    return { settled: true, isError: true === result?.isError, text, layer: 'tool' };
  } catch (error) {
    const msg = String(error?.message ?? error);
    // A protocol rejection (-32602 and friends) is still an ANSWER. A timeout is not.
    return { settled: !/timeout after/.test(msg), isError: true, text: msg, layer: 'protocol' };
  }
}

// Wait for the driven page BEFORE fuzzing, and assert it. Without a session every tool
// short-circuits on "no browser session connected" and the whole fuzz passes without reaching a
// single validator — which is exactly how this spec went green on its first run, hiding a
// 100,392-byte answer. A vacuous pass is worse than a failure: it reports coverage it does not have.
// "some sessionId appears in the response" was too weak in the other direction: a stray tab in the
// developer's own browser satisfies it, and the fuzz then runs with OUR app still absent. Match the
// app being driven by the URL it is serving from — bench-app self-assigns a per-tab id.
const driven = await waitForSession(
  async () => {
    const probe = await callRaw('reticle_sessions', {});
    try {
      return JSON.parse(probe.text)?.sessions ?? [];
    } catch {
      return [];
    }
  },
  (s) => String(s?.url ?? '').startsWith(APP),
  { what: `the driven app on ${APP}` },
);
chk('a session is driving, so the fuzz reaches real validators', 0 < driven.length);

/** An answer is actionable if it says something a caller could act on beyond "no". */
function actionable(text) {
  if (10 > text.trim().length) return false;
  return /error|invalid|required|expected|must|unknown|recovery|reason|refus|missing|no /i.test(text);
}

const reached = { protocol: 0, tool: 0 };
const hung = [];
/** Answered only on the retry: worth REPORTING (it says the runner was loaded) but never a failure. */
const slow = [];
const blamed = [];
const leaked = [];
const vague = [];
let calls = 0;

for (const tool of tools) {
  for (const [shape, args] of hostileArgs(tool.inputSchema)) {
    const r = await callRaw(tool.name, args);
    calls += 1;
    const where = `${tool.name}/${shape}`;
    if (!r.settled) {
      hung.push(where);
      continue;
    }
    reached[r.layer] += 1;
    if (r.text.includes(FEEDBACK_ASK_MARKER)) blamed.push(where);
    if (STACK_MARKERS.some((re) => re.test(r.text))) leaked.push(`${where}: ${r.text.slice(0, 120)}`);
    if (r.isError && !actionable(r.text)) vague.push(`${where}: ${JSON.stringify(r.text.slice(0, 80))}`);
  }
}

console.log(`   (${reached.protocol} rejected at the protocol layer, ${reached.tool} reached the tool)`);

const show = (list, n = 4) => list.slice(0, n).join(' | ') + (n < list.length ? ` (+${list.length - n} more)` : '');

chk(
  'every tool answers every hostile call',
  0 === hung.length,
  0 === hung.length ? `${calls} calls` : show(hung),
);
// Reported, never a failure. A retry that succeeded says the RUNNER was loaded — which is worth
// knowing (it is the difference between "this box is busy" and "this tool is broken") and is
// precisely what the four previous retunes of CALL_TIMEOUT_MS were trying and failing to express.
if (slow.length > 0) {
  console.log(`   ℹ  ${slow.length} call(s) needed a retry: ${show(slow, 3)}`);
}
chk('  no bad argument is blamed on Reticle', 0 === blamed.length, 0 === blamed.length ? 'none' : show(blamed));
chk('  no answer leaks a stack trace', 0 === leaked.length, 0 === leaked.length ? 'none' : show(leaked, 2));
chk('  every refusal is actionable', 0 === vague.length, 0 === vague.length ? 'all' : show(vague));

// The pollution attempt must not have taken. If it had, EVERY object in this process would carry it.
chk('  prototype survived the junk-key shape', undefined === {}.polluted);

// And after all of that, the server is still the server.
const after = await client.listTools().catch(() => []);
chk('the tool surface is intact afterwards', after.length === tools.length, `${after.length}/${tools.length}`);

await client.stop();
console.log(`\n${0 === fail ? '✅' : '❌'} TOOL FUZZ (${pass} passed, ${fail} failed, ${calls} hostile calls)`);
process.exit(0 === fail ? 0 : 1);
