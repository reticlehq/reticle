// Brute force against the FOURTH channel: the bridge wire itself — SDK ↔ daemon.
//
// browser-stress covers tab lifecycle THROUGH this socket. This attacks the socket: connection
// floods, the session cap, oversized frames, malformed frames, message floods past the rate cap,
// and sockets killed mid-handshake. The SDK is embedded in somebody's dev app, so everything here
// is something a real page can do by accident — a hot-reload loop, a chatty observer, a 2MB DOM
// snapshot — and none of it may take the daemon down or corrupt a healthy session.
//
// The bar, same as the other three channels:
//   1. the daemon survives and keeps serving;
//   2. a healthy session is never collateral damage;
//   3. a limit that is enforced is ENFORCED — the constants in TRANSPORT_LIMITS are a promise, and
//      an unenforced cap is worse than no cap because the code above it assumes the bound holds.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  MessageKind,
  RETICLE_WS_PATH,
  RETICLE_PROTOCOL_VERSION,
  TRANSPORT_LIMITS,
  CONTRACT_FINGERPRINT,
} from '@reticlehq/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.BRIDGE_STRESS_PORT ?? '4741');
const WS_URL = `ws://127.0.0.1:${String(PORT)}${RETICLE_WS_PATH}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bridge refuses an unauthenticated hello even on loopback, so every socket below has to pair
// like a real SDK does. Reading it here rather than hardcoding: the token is per-machine.
const TOKEN = (() => {
  try {
    return readFileSync(path.join(homedir(), '.reticle', 'pairing-token'), 'utf8').trim();
  } catch {
    return undefined;
  }
})();

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

// `null` means "send no token" — distinct from `undefined`, which a default parameter would quietly
// replace with the real token and turn the negative control into a second positive one. It did.
const NO_TOKEN = null;

const hello = (sessionId, token = TOKEN) => ({
  ...(token === undefined || NO_TOKEN === token ? {} : { token }),
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId,
  url: `http://localhost/${sessionId}`,
  title: 'stress',
  adapters: [],
  hasCapabilities: false,
  contract: CONTRACT_FINGERPRINT,
});

/** Open a socket and say hello. Resolves once the socket is open, or null if it never opened. */
function connect(sessionId, { sayHello = true, token = TOKEN } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const done = (value) => resolve(value);
    ws.on('open', () => {
      if (sayHello) ws.send(JSON.stringify(hello(sessionId, token)));
      done(ws);
    });
    ws.on('error', () => done(null));
    ws.on('unexpected-response', () => done(null));
    setTimeout(() => done(null), 5000);
  });
}

async function statusSessions() {
  const res = await fetch(`http://127.0.0.1:${String(PORT)}/status`).catch(() => null);
  if (res === null) return null;
  const body = await res.json().catch(() => null);
  return body?.sessions ?? null;
}

const daemonAlive = async () => (await statusSessions()) !== null;

console.log('\n=== BRIDGE STRESS: the SDK ↔ daemon wire ===');
process.on('unhandledRejection', () => undefined);
process.chdir(ROOT);

// A daemon of our own, on a port nothing else in the battery uses.
execSync(`node packages/server/dist/cli.js stop --port ${String(PORT)} --quiet || true`, {
  stdio: 'ignore',
  shell: '/bin/sh',
});
const daemon = execSync(
  `node packages/server/dist/cli.js serve --port ${String(PORT)} >/dev/null 2>&1 & echo started`,
  { shell: '/bin/sh' },
).toString();
void daemon;
for (let i = 0; 40 > i; i += 1) {
  if (await daemonAlive()) break;
  await sleep(250);
}
chk('the bridge is up', await daemonAlive());
chk('a pairing token is available to connect with', TOKEN !== undefined);

// ── 0. The negative control, and a security property in its own right ─────────────────────────
// Every check below is worthless if a hello silently fails: the session cap "holds" at zero, the
// innocent bystander is never there to be harmed. So prove the handshake works, and prove that an
// UNAUTHENTICATED one does not — the bridge listens on a port any process on the machine can reach.
{
  const anon = await connect('no-token-at-all', { token: NO_TOKEN });
  await sleep(1200);
  const sessions = await statusSessions();
  const listed = (sessions ?? []).some((s) => 'no-token-at-all' === (s.sessionId ?? s.id));
  chk('an unauthenticated hello is refused', !listed);
  if (anon !== null) anon.close();

  const paired = await connect('handshake-probe');
  await sleep(1200);
  const after = await statusSessions();
  chk(
    'an authenticated hello IS accepted, so the rest of this spec means something',
    (after ?? []).some((s) => 'handshake-probe' === (s.sessionId ?? s.id)),
    `${String(after?.length ?? -1)} session(s)`,
  );
  if (paired !== null) paired.close();
  await sleep(500);
}

const open = [];
try {
  // ── 1. The session cap is real ───────────────────────────────────────────────────────────────
  // TRANSPORT_LIMITS.MAX_SESSIONS exists so memory cannot be grown without bound by a page that
  // reconnects in a loop. A cap nothing enforces is the worst kind: everything above it is written
  // as if the bound holds.
  {
    const want = TRANSPORT_LIMITS.MAX_SESSIONS + 8;
    for (let i = 0; want > i; i += 1) {
      const ws = await connect(`stress-${String(i)}`);
      if (ws !== null) open.push(ws);
    }
    await sleep(1500);
    const sessions = await statusSessions();
    const count = Array.isArray(sessions) ? sessions.length : -1;
    chk(
      'the session cap holds under more connections than it allows',
      0 < count && TRANSPORT_LIMITS.MAX_SESSIONS >= count,
      `${String(count)} sessions, cap ${String(TRANSPORT_LIMITS.MAX_SESSIONS)} (offered ${String(want)})`,
    );
    chk('  and the daemon is still serving', await daemonAlive());
  }

  // ── 2. A healthy session survives an oversized frame from a NOISY NEIGHBOUR ───────────────────
  // The frame is over MAX_MESSAGE_BYTES, so the offender's socket is expected to die. What must not
  // happen is the daemon dying with it, or the innocent session going away.
  {
    const victim = await connect('bystander');
    await sleep(600);
    const before = (await statusSessions())?.length ?? 0;
    const loud = await connect('too-loud');
    if (loud !== null) {
      loud.send('x'.repeat(TRANSPORT_LIMITS.MAX_MESSAGE_BYTES + 4096));
      open.push(loud);
    }
    await sleep(1200);
    chk('an oversized frame does not take the daemon down', await daemonAlive());
    const after = (await statusSessions())?.length ?? 0;
    chk(
      '  and the innocent session is still connected',
      0 < before && after >= before - 1,
      `${String(before)} -> ${String(after)}`,
    );
    if (victim !== null) open.push(victim);
  }

  // ── 3. Malformed frames ──────────────────────────────────────────────────────────────────────
  // Anything reading a socket has to survive what a buggy — or hostile — client sends.
  {
    const ws = await connect('malformed');
    if (ws !== null) {
      ws.send('not json at all');
      ws.send('{"kind":"hello"}'); // right kind, nothing else
      ws.send('{"kind":"nonsense","x":1}');
      ws.send(JSON.stringify({ kind: MessageKind.EVENT, event: null }));
      ws.send(JSON.stringify({ __proto__: { polluted: true }, kind: MessageKind.EVENT }));
      open.push(ws);
    }
    await sleep(800);
    chk('malformed frames do not take the daemon down', await daemonAlive());
    chk('  and no prototype was polluted in this process', undefined === {}.polluted);
  }

  // ── 4. A message flood past the rate cap ─────────────────────────────────────────────────────
  // The cap drops events on purpose; blind-spots reports the window as SAMPLED rather than pretending
  // it saw everything. The property here is only that the flood cannot kill anything.
  {
    const ws = await connect('flood');
    if (ws !== null) {
      for (let i = 0; 5000 > i; i += 1) {
        ws.send(
          JSON.stringify({
            kind: MessageKind.EVENT,
            event: { type: 'console.log', t: i, seq: i, data: { text: `m${String(i)}` } },
          }),
        );
      }
      open.push(ws);
    }
    await sleep(1500);
    chk('a 5000-message flood does not take the daemon down', await daemonAlive());
  }

  // ── 5. Sockets killed mid-handshake, repeatedly ──────────────────────────────────────────────
  // A dev server restarting in a loop looks exactly like this. Each one must be cleaned up; if they
  // are not, the session cap fills with corpses and the next real page cannot connect.
  {
    for (let i = 0; 60 > i; i += 1) {
      const ws = new WebSocket(WS_URL);
      ws.on('error', () => undefined);
      // Destroy without ever completing the handshake, at a varying point in it.
      setTimeout(() => ws.terminate(), i % 7);
    }
    await sleep(2500);
    chk('60 aborted handshakes do not take the daemon down', await daemonAlive());
  }

  // ── 6. After all of it, a real page can still connect and be seen ────────────────────────────
  {
    for (const ws of open.splice(0)) ws.close();
    await sleep(2000);
    const fresh = await connect('after-the-storm');
    await sleep(1500);
    const sessions = await statusSessions();
    const seen = (sessions ?? []).some((s) => 'after-the-storm' === (s.sessionId ?? s.id));
    chk('a new session still connects and is listed afterwards', seen, `${String(sessions?.length ?? -1)} session(s)`);
    if (fresh !== null) fresh.close();
  }
} finally {
  for (const ws of open) {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
  execSync(`node packages/server/dist/cli.js stop --port ${String(PORT)} --quiet || true`, {
    stdio: 'ignore',
    shell: '/bin/sh',
  });
}

console.log(`\n${0 === fail ? '✅' : '❌'} BRIDGE STRESS (${pass} passed, ${fail} failed)`);
process.exit(0 === fail ? 0 : 1);
