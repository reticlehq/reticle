// The calls SKILL.md tells an agent to make, made the way SKILL.md says to make them.
//
// The skill leads with one-call paths — "did my edit break anything", "does this known journey still
// work" — and with record-once-replay-cheap. Every one of those tools is OFF the default advertised
// surface, so the skill has to teach both the tool AND the envelope that reaches it:
// `reticle_run { tool, args }`. That composition is the thing under test here.
//
// Nothing else covers it. `tool-surface-sweep-test` sets RETICLE_ADVERTISE_ALL_TOOLS and calls every
// tool DIRECTLY by name, which is the right way to sweep the surface and the wrong way to learn what
// an ordinary agent can reach — under the default profile those names are not advertised at all, so
// a direct call is `unknown tool` and the only route is through `reticle_run`. So the surface sweep
// can be green while every instruction in the skill is unreachable.
//
// The failure this exists to catch is specific and has happened: a draft of these instructions named
// `reticle_flow_save_recorded` (the in-page HUMAN recorder's path, not the agent's), called
// `reticle_record_stop` with no active recording, and passed `name` where both `flow_save` and
// `flow_replay` require `flowName`. Every one of those would have been refused at runtime while the
// documentation looked entirely reasonable.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { waitForSession } from '../wait-for-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.RETICLE_PORT ?? '4400';
const APP = process.env.SWEEP_APP_URL ?? 'http://localhost:4310/';

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

/*
 * The DEFAULT surface, on a side port, and it drives nothing.
 *
 * Every question asked of this client is `tools/list` — what does a user actually get handed — and
 * a surface listing needs no app. It gets the side port precisely BECAUSE it needs no session: the
 * app under test is built to dial the bridge on RETICLE_PORT, so only a daemon holding that port
 * can ever receive one, and that daemon has to be the one the envelope calls go to.
 *
 * DELIBERATELY no RETICLE_ADVERTISE_ALL_TOOLS: the point is the surface a user actually gets.
 */
const LEAN_PORT = String(Number(PORT) + 2);
const client = new McpStdioClient(
  'node',
  ['server/dist/command/cli.js', 'mcp', '--port', LEAN_PORT],
  { RETICLE_PORT: LEAN_PORT, RETICLE_TELEMETRY: '0' },
);

/**
 * The second surface, because SKILL.md now describes two.
 *
 * This spec was written when the default surface carried `reticle_run`, and its premise was that
 * the cold-tail tools could only be reached through that envelope. The default is now the merged
 * nine, which drops the dispatch hatch BY NAME -- so the envelope section below was calling a tool
 * that no longer exists and the whole spec died on its first `viaRun`.
 *
 * SKILL.md was already right about this: its `reticle_run` examples sit under a heading that says
 * "Extended surface only". So each half is now checked against the surface the skill assigns it,
 * which is what keeps this spec measuring the instructions rather than a past release.
 */
/*
 * Its own DAEMON, and it holds the real port. Neither half of that is a detail.
 *
 * The surface is read once at daemon startup, not per proxy — dynamic-tools.ts says so in the note
 * it attaches to every catalogue. Pointed at a port another daemon already owns, this inherited
 * that daemon's surface and every `reticle_run` call below answered "Tool reticle_run not found",
 * which `rejected()` did not recognise, so five checks passed having called nothing at all.
 *
 * And it is THIS one that gets RETICLE_PORT, because the app under test connects to whatever
 * daemon holds that port. Given the side port instead, it drove a browser that dialled somebody
 * else, so it owned no session and every envelope answered "no connected session" — accepted
 * arguments, no answer, and only the one check that reads an ANSWER caught it.
 */
const extended = new McpStdioClient(
  'node',
  ['server/dist/command/cli.js', 'mcp', '--port', PORT, '--drive', APP],
  { RETICLE_PORT: PORT, RETICLE_TELEMETRY: '0', RETICLE_ADVERTISE_ALL_TOOLS: '1' },
);

/** Call through the skill's own envelope and hand back whatever came out, refusals included. */
let SID;
/**
 * The budget is generous ON PURPOSE, and it is not tuned to this machine.
 *
 * `reticle_verify { action: "change" }` replays EVERY saved flow whose covered sources it cannot
 * determine — over-running beats silently skipping, which is the right trade and is documented in
 * `attributed-failure.ts`. So this call's cost grows with the number of saved flows in whatever
 * repository it runs against, without bound. Measured here at 43.8s over 39 flows; CI has a slower
 * runner and more flows by the time this spec runs, so 60s was a statement about the machine, and
 * it failed only in CI — which is exactly what a timing assertion does.
 *
 * What this spec asserts is that the SKILL's one-call paths resolve and answer. It has never been
 * about how long they take, and a cap that turns a working path into a red is measuring the wrong
 * thing. If the cost itself is the worry, that belongs in the benchmark, where it is compared
 * against a baseline rather than against a stopwatch.
 */
const CALL_BUDGET_MS = 240_000;

async function viaRun(tool, args) {
  const result = await extended.request(
    'tools/call',
    { name: 'reticle_run', arguments: { tool, args, ...(SID === undefined ? {} : { sessionId: SID }) } },
    CALL_BUDGET_MS,
  );
  const text = (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * An answer that means "this tool does not exist" or "these arguments are wrong".
 *
 * `raw` is checked as well as `error`, and that is what this missed: a transport-level refusal
 * comes back as unparsed text (`MCP error -32602: Tool reticle_run not found`) with no `error`
 * field, so five checks read it as acceptance and went green against a tool that was not there.
 */
const rejected = (answer) => {
  const text =
    typeof answer?.error === 'string' ? answer.error : typeof answer?.raw === 'string' ? answer.raw : '';
  return /unknown tool|not found|does not accept|unknown parameter|required|-32602/i.test(text);
};

process.on('exit', () => {
  client.stop?.();
  extended.stop?.();
});

await client.start();
await extended.start();
console.log('\n=== SKILL.md one-call paths, over real MCP at the DEFAULT surface ===');

const advertised = await client.listTools();
const names = new Set(advertised.map((t) => t.name));
chk('the default surface is the lean one, not the full list', names.size < 40, `${names.size} tools`);

// The premise of the skill's instructions. If these ever became advertised, the skill should stop
// teaching the envelope — and this is the check that would say so instead of leaving it stale.
// `reticle_verify` was promoted INTO the default surface, so it is deliberately absent from this
// list: the skill now teaches the direct call for it. The other three are still cold-tail, and the
// envelope is still the only way to reach them.
for (const tool of ['reticle_flow_replay', 'reticle_record', 'reticle_flow_save']) {
  chk(`  ${tool} is NOT advertised here, so the skill must scope it to the extended surface`, !names.has(tool));
}
// Inverted TWICE, and the second inversion is the one that matters. This read "reticle_run IS
// advertised" on the old default, then "is NOT advertised: the nine are a CLOSED surface" when the
// merged nine became the default -- and that second claim was true for exactly as long as it took
// somebody to notice that eleven registered tools were then reachable by nothing at all. The
// surface demotes the extended set on the promise that each member is still one reticle_run hop
// away; dropping the hatch cancelled the half of the trade we owed the caller. The hatch is back,
// so it is advertised here, and the skill teaches the envelope rather than telling an agent that a
// tool it can reach is out of reach.
chk('reticle_run IS advertised: the hatch is what makes the unadvertised tail reachable', names.has('reticle_run'));
chk('reticle_verify IS advertised, so the skill teaches it directly', names.has('reticle_verify'));

// Proving the SECOND surface is actually extended. Without this the envelope section below can run
// entirely against a merged daemon and report success for calls that never happened.
const extendedNames = new Set((await extended.listTools()).map((t) => t.name));
chk(
  'the extended surface really does advertise reticle_run, or the section below proves nothing',
  extendedNames.has('reticle_run'),
  `${extendedNames.size} tools`,
);

// A real driven session first, or every answer below is "no browser session connected" — which the
// envelope check would still pass (the arguments were accepted) while proving nothing about what the
// tools actually answer. The skill's claims are about the answers.
//
// Asked of `extended`, NOT `client`, and that is the whole point: these are two daemons on two
// ports, each driving its own copy of the app, and a session id is only meaningful to the daemon
// that owns it. Taken from `client` it named a session `extended` had never seen, so every envelope
// below answered "no connected session with id …" — which `rejected()` does not treat as a refusal,
// because the arguments really were accepted. The calls went green and the one check that reads an
// ANSWER rather than an acceptance was the only one that noticed.
const [driven] = await waitForSession(
  async () => {
    // `reticle_sessions` first, and that ordering is the point: the MERGED `reticle_session
    // { action: "list" }` is a DEFAULT-surface shape, and this daemon runs the extended one, where
    // the unmerged tool is what is advertised. Asking for the merged name here returned a protocol
    // error, which this poll swallowed as "no sessions yet" and then spent sixty seconds proving.
    // Both names are tried so the poll survives whichever surface it is pointed at.
    for (const call of [
      { name: 'reticle_sessions', arguments: {} },
      { name: 'reticle_session', arguments: { action: 'list' } },
    ]) {
      const r = await extended.request('tools/call', call, 30_000).catch(() => undefined);
      const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      try {
        const sessions = JSON.parse(text)?.sessions;
        if (Array.isArray(sessions)) return sessions;
      } catch {
        /* the other spelling, or genuinely nothing yet */
      }
    }
    return [];
  },
  (s) => String(s?.url ?? '').startsWith(APP),
  { what: `the driven app on ${APP}` },
);
SID = driven.sessionId ?? driven.id;
chk('a driven session is live, so the answers below are real', typeof SID === 'string' && SID.length > 0, SID);

// ── The exact envelopes SKILL.md prints ────────────────────────────────────────────────────────
const started = await viaRun('reticle_record', { action: 'start', recordingName: 'skill-check' });
chk(
  'reticle_run { reticle_record, action:"start", recordingName }',
  !rejected(started),
  JSON.stringify(started).slice(0, 110),
);

const stopped = await viaRun('reticle_record', { action: 'stop', recordingName: 'skill-check' });
chk(
  'reticle_run { reticle_record, action:"stop", recordingName }',
  !rejected(stopped),
  JSON.stringify(stopped).slice(0, 110),
);

const saved = await viaRun('reticle_flow_save', { flowName: 'skill-check' });
chk(
  'reticle_run { reticle_flow_save, flowName }',
  !rejected(saved),
  JSON.stringify(saved).slice(0, 110),
);

const replayed = await viaRun('reticle_flow_replay', { flowName: 'skill-check' });
chk(
  'reticle_run { reticle_flow_replay, flowName }',
  !rejected(replayed),
  JSON.stringify(replayed).slice(0, 110),
);

const changed = await viaRun('reticle_verify', { action: 'change', files: ['src/App.tsx'] });
chk(
  'reticle_run { reticle_verify_change, files }',
  !rejected(changed),
  JSON.stringify(changed).slice(0, 110),
);

// The skill tells the reader that `unknown` here means "nothing covers this", NOT a pass. If that
// stops being the shape of the answer, the skill is teaching a misreading.
chk(
  '  and it answers with a verdict field, which is what the skill tells the reader to read',
  changed?.verified !== undefined || typeof changed?.because === 'string',
  `verified=${String(changed?.verified)}`,
);

// The names the draft got WRONG. Kept as a live check rather than a comment: if one of these ever
// starts resolving, the skill should be teaching it, and if it does not, this is the reminder of why
// the instructions say what they say.
const wrongName = await viaRun('reticle_record_stop', {});
chk(
  'the draft spelling reticle_record_stop is still not a bare tool name',
  rejected(wrongName) || wrongName?.error !== undefined,
  String(wrongName?.error ?? '').slice(0, 90),
);

console.log(
  `\n${fail === 0 ? '✅' : '❌'} SKILL ONE-CALL PATHS (${pass} passed, ${fail} failed)`,
);
client.stop?.();
extended.stop?.();
process.exit(fail === 0 ? 0 : 1);
