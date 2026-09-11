// `reticle drive` while a daemon already owns the bridge port.
//
// Reported twice from the field, a week apart: the daemon the agent's own MCP proxy started holds
// :4400, so `drive` — the command Reticle's own session recommendation points at for "a guaranteed
// scriptable context" — died on EADDRINUSE. The documented workaround (`reticle stop`, then drive)
// is a race the user cannot win, because the proxy respawns a daemon into the gap. One reporter
// gave up and drove headless Chrome over raw CDP instead.
//
// `drive` now ASKS the daemon that is already there for a pooled context, and the session it hands
// back lives in that daemon — which is the part that matters, because the agent's tools are already
// pointed at it. Nothing here asserts a duration: the invariants are the exit code, the session
// existing in the daemon's /status, and EADDRINUSE never reaching a reader.
//
// Needs the next-smoke app on :3100 (it must be a real, instrumented page for a lease to connect).
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePortSafely } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'packages/server/dist/cli.js');
// :4400 and not a private port: the apps this battery boots were built to dial 4400, so a lease on
// any other port would open a tab that can never connect and the spec would be measuring the port
// mismatch instead of the attach. The runner frees this port between specs.
const PORT = Number(process.env.DRIVE_ATTACH_PORT ?? '4400');
const APP = process.env.DRIVE_ATTACH_URL ?? 'http://localhost:3100/';

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const env = { ...process.env, RETICLE_TELEMETRY: '0', RETICLE_PORT: String(PORT) };
const cli = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
const said = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;

console.log('\n=== DRIVE ATTACH: driving while a daemon owns the port ===');

process.chdir(ROOT);
await freePortSafely(PORT);

// A real daemon on the port — the ordinary state five seconds after any agent connects.
const serve = cli('serve', '--port', String(PORT));
chk('a daemon is serving the port', serve.status === 0, said(serve).trim().split('\n').pop() ?? '');

const drive = cli('drive', APP);
const droveSaid = said(drive);
chk('drive exits 0 instead of refusing the port its own daemon holds', drive.status === 0, `exit ${String(drive.status)}`);
chk('  and NEVER shows the user an EADDRINUSE', !/EADDRINUSE/.test(droveSaid));
chk('  and reports it attached rather than bound', droveSaid.includes('reticle_drive_attached'));

const sessionId = /"sessionId":"([^"]+)"/.exec(droveSaid)?.[1];
chk('  and names the session it opened', typeof sessionId === 'string', sessionId ?? droveSaid.trim().split('\n').pop() ?? '');

// The point of attaching rather than binding: the session belongs to the DAEMON, so the tools the
// agent already has open on that daemon can address it. A drive that opened a browser in its own
// process would leave /status empty here.
const status = cli('status', '--port', String(PORT));
chk(
  'the session lives in the running daemon, where the agent’s tools already are',
  typeof sessionId === 'string' && said(status).includes(sessionId),
  said(status).trim().split('\n').pop() ?? '',
);

cli('stop', '--port', String(PORT));
await freePortSafely(PORT);

// The control: a port held by something that is NOT a daemon cannot be attached to either, and must
// still be refused in words. Without this, "drive always exits 0" would pass every check above.
const squatter = net.createServer((socket) => socket.on('error', () => {}));
await new Promise((resolve) => squatter.listen(PORT, '127.0.0.1', resolve));
const refused = cli('drive', APP);
const refusedSaid = said(refused);
chk('a stranger on the port is still refused', refused.status !== 0, `exit ${String(refused.status)}`);
chk('  in a sentence, never an errno', !/EADDRINUSE/.test(refusedSaid) && refusedSaid.includes(String(PORT)));
await new Promise((resolve) => squatter.close(resolve));

console.log(
  `\n${fail === 0 ? '✅ DRIVE ATTACH VERIFIED' : '❌ DRIVE ATTACH FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
