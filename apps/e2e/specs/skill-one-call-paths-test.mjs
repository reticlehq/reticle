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

// DELIBERATELY no RETICLE_ADVERTISE_ALL_TOOLS: the point is the surface a user actually gets.
const client = new McpStdioClient(
  'node',
  ['packages/server/dist/cli.js', 'mcp', '--port', PORT, '--drive', APP],
  { RETICLE_PORT: PORT, RETICLE_TELEMETRY: '0' },
);

/** Call through the skill's own envelope and hand back whatever came out, refusals included. */
let SID;
async function viaRun(tool, args) {
  const result = await client.request(
    'tools/call',
    { name: 'reticle_run', arguments: { tool, args, ...(SID === undefined ? {} : { sessionId: SID }) } },
    60_000,
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

/** An answer that means "this tool does not exist" or "these arguments are wrong". */
const rejected = (answer) =>
  typeof answer?.error === 'string' &&
  /unknown tool|does not accept|unknown parameter|required/i.test(answer.error);

process.on('exit', () => client.stop?.());

await client.start();
console.log('\n=== SKILL.md one-call paths, over real MCP at the DEFAULT surface ===');

const advertised = await client.listTools();
const names = new Set(advertised.map((t) => t.name));
chk('the default surface is the lean one, not the full list', names.size < 40, `${names.size} tools`);

// The premise of the skill's instructions. If these ever became advertised, the skill should stop
// teaching the envelope — and this is the check that would say so instead of leaving it stale.
for (const tool of [
  'reticle_verify_change',
  'reticle_flow_replay',
  'reticle_record',
  'reticle_flow_save',
]) {
  chk(`  ${tool} is NOT advertised, so the skill must teach reticle_run`, !names.has(tool));
}
chk('reticle_run IS advertised, since everything above depends on it', names.has('reticle_run'));

// A real driven session first, or every answer below is "no browser session connected" — which the
// envelope check would still pass (the arguments were accepted) while proving nothing about what the
// tools actually answer. The skill's claims are about the answers.
const [driven] = await waitForSession(
  async () => {
    const r = await client.request('tools/call', { name: 'reticle_sessions', arguments: {} }, 30_000);
    const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    try {
      return JSON.parse(text)?.sessions ?? [];
    } catch {
      return [];
    }
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

const changed = await viaRun('reticle_verify_change', { files: ['src/App.tsx'] });
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
process.exit(fail === 0 ? 0 : 1);
