// Do the three pieces agree on the contract — and if not, is the AGENT told, with a fix?
//
// Reticle is three separately-installed pieces (the SDK in the page, the daemon, the MCP server the
// agent spawns) upgraded independently and therefore drifting constantly. Every pair fails the same
// silent way: `protocolVersion` still matches, the connection succeeds, and only BEHAVIOUR
// disagrees. A user hit exactly that with a 2.2.1 SDK against a 2.3.0 daemon and saw a bare `-32000`
// with nothing on either side naming a version.
//
// The mechanism for that shipped without ever being driven end to end. When it finally was, it was
// silent for a reason no unit test could show: the nudge only rides out on a tool result that is a
// PLAIN OBJECT, and the first tool tried (`reticle_snapshot`) returns an array. The rule was right,
// the delivery was untested. Hence this spec.
//
// Needs no browser and none of the battery's servers — a fake peer and a fake SDK are enough, and
// being able to LIE about a contract is the whole point.
import path from 'node:path';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.SKEW_PORT ?? '4409';
const CLI = path.join(ROOT, 'packages', 'server', 'dist', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

console.log('\n=== VERSION SKEW: does the agent get told, and does it get told what to run? ===');

const PROJECT = mkdtempSync(path.join(tmpdir(), 'reticle-skew-'));
process.chdir(PROJECT);
spawnSync('node', [CLI, 'stop', '--port', PORT, '--quiet'], { cwd: PROJECT });
await sleep(500);

const client = new McpStdioClient('node', [CLI, 'mcp', '--port', PORT], {
  RETICLE_PORT: PORT,
  RETICLE_ADVERTISE_ALL_TOOLS: '1',
  RETICLE_TELEMETRY: '0',
});
await client.start();

// `reticle_sessions` returns a PLAIN OBJECT, which is what the nudge splices onto. Using a tool that
// returns an array here would make every assertion below pass for the wrong reason.
const call = async (name, args = {}) => {
  try {
    const r = await client.request('tools/call', { name, arguments: args }, 30_000);
    const t = (r?.content ?? []).map((c) => c.text ?? '').join('\n');
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  } catch (e) {
    return { PROTO: String(e?.message ?? e) };
  }
};

const getJson = (path_) =>
  new Promise((resolve) => {
    const req = request({ host: 'localhost', port: Number(PORT), path: path_ }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve({});
        }
      });
    });
    req.on('error', () => resolve({}));
    req.end();
  });

// Wait for the daemon, and learn what this build says about itself.
let status = {};
for (let i = 0; i < 40; i++) {
  status = await getJson('/status');
  if (typeof status.contract === 'string') break;
  await sleep(500);
}
chk(
  '/status states this build version AND contract fingerprint',
  typeof status.version === 'string' && typeof status.contract === 'string',
  `version=${status.version} contract=${status.contract}`,
);

/** Connect a peer to the SSE endpoint claiming a version + contract, then drop it. */
const announcePeer = (version, contract) =>
  new Promise((resolve) => {
    const q = `?peerVersion=${encodeURIComponent(version)}&peerContract=${encodeURIComponent(contract)}`;
    const req = request({ host: 'localhost', port: Number(PORT), path: `/mcp/sse${q}` }, (res) => {
      res.on('data', () => {});
      setTimeout(() => {
        res.destroy();
        resolve();
      }, 600);
    });
    req.on('error', () => resolve());
    req.end();
  });

// ── A. everything agrees -> SILENT ─────────────────────────────────────────────────────────────
// The most important case: a matched install must say nothing. A skew warning that cries wolf on
// every patch release is worse than none, which is why the signal is the contract, not the version.
await announcePeer(status.version, status.contract);
const matched = await call('reticle_sessions');
chk(
  'a peer on the SAME contract produces no warning',
  matched?.version_skew === undefined,
  JSON.stringify(matched?.version_skew ?? 'silent'),
);

// ── B. the agent's MCP server disagrees ────────────────────────────────────────────────────────
await announcePeer('0.0.1', 'deadbeefdead');
const mcpSkew = (await call('reticle_sessions'))?.version_skew;
chk(
  'a peer on a DIFFERENT contract reaches the agent on its next tool result',
  typeof mcpSkew?.action === 'string' && mcpSkew.pair === 'daemon',
  String(mcpSkew?.action).slice(0, 80),
);
chk(
  'and the message tells the agent what to RUN',
  String(mcpSkew?.action).includes('reticle stop'),
  'names the command that replaces the stale daemon',
);

// ── C. the SDK in the page disagrees ───────────────────────────────────────────────────────────
// A hand-rolled HELLO, because lying about the contract is exactly what a stale SDK does. Origin is
// required (the bridge checks it) and the path is /reticle.
const ws = new WebSocket(`ws://localhost:${PORT}/reticle`, { origin: 'http://localhost:4310' });
let wsProblem = '';
await new Promise((resolve) => {
  ws.on('open', resolve);
  ws.on('error', (e) => {
    wsProblem = String(e?.message ?? e);
    resolve();
  });
});
ws.on('close', (code, reason) => {
  if (wsProblem === '') wsProblem = `closed ${code} ${String(reason)}`;
});
// The daemon auto-provisions a pairing token and REQUIRES it on the HELLO; a real SDK reads the
// same file through its build plugin. Without it the connection closes 1008 and this case would
// silently not run at all.
let token;
try {
  token = readFileSync(path.join(homedir(), '.reticle', 'pairing-token'), 'utf8').trim();
} catch {
  token = undefined;
}
ws.send(
  JSON.stringify({
    kind: 'hello',
    protocolVersion: 1,
    sessionId: 'stale-sdk-probe',
    url: 'http://localhost:9999/stale',
    title: 'stale sdk',
    adapters: [],
    hasCapabilities: false,
    sdkVersion: '0.0.1',
    contract: 'deadbeefdead',
    ...(token === undefined ? {} : { token }),
  }),
);
await sleep(1200);

const sessions = await call('reticle_sessions');
const stale = (sessions?.sessions ?? []).find((s) => s.sessionId === 'stale-sdk-probe');
chk('the stale SDK connected at all, so this case is really exercised', stale !== undefined, wsProblem);
chk(
  'the session reports the skew',
  typeof stale?.versionSkew === 'string' && stale.versionSkew.includes('the page is 0.0.1'),
  String(stale?.versionSkew).slice(0, 80),
);
chk(
  'and the message tells the agent what the HUMAN must install',
  String(stale?.versionSkew).includes('@reticlehq/') &&
    String(stale?.versionSkew).includes('restart'),
  'names the package and the dev-server restart',
);

try {
  ws.close();
} catch {
  /* already closed */
}
spawnSync('node', [CLI, 'stop', '--port', PORT, '--quiet'], { cwd: PROJECT });

console.log(`\n${fail === 0 ? '✅ VERSION SKEW VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
