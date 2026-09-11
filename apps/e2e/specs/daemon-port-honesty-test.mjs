// When the bridge port is held by a stranger, every surface must say SO — and none of them did.
//
// Reproduced by hand on main, with a plain TCP server squatting on the port:
//
//   $ reticle serve   -> {"event":"reticle_daemon_spawned","port":4400}      exit 0
//   $ reticle status  -> {"event":"reticle_status","port":4400,"running":false}
//   $ tail -1 ~/.reticle/daemon-4400.log
//                     -> {"event":"reticle_daemon_start_failed","error":"listen EADDRINUSE ..."}
//
// The daemon knew exactly what was wrong and wrote it where nobody looks. `serve` reported the
// SPAWN, not the bind; `status` read the pid file, which is not the port. So "a stranger holds this
// port" and "nothing is here" were the same output, and the true sentence was never said by anything
// a person sees.
//
// Needs no browser and no servers — it holds a socket and runs three CLI commands.
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePortSafely } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'packages/server/dist/cli.js');
const PORT = Number(process.env.DAEMON_PORT_HONESTY_PORT ?? '4744');

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const cli = (...args) =>
  spawnSync(process.execPath, [CLI, ...args, '--port', String(PORT)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, RETICLE_TELEMETRY: '0' },
    timeout: 60_000,
  });

console.log('\n=== DAEMON PORT HONESTY: a port held by a stranger is reported as one ===');

process.chdir(ROOT);
await freePortSafely(PORT);

// A squatter that ACCEPTS and never serves. This is not a contrived shape: it is what a dying daemon
// leaves for a second or two, and what a second agent on the same machine creates.
const squatter = net.createServer((socket) => socket.on('error', () => {}));
await new Promise((resolve) => squatter.listen(PORT, '127.0.0.1', resolve));

const serve = cli('serve');
chk(
  'serve REFUSES rather than reporting a spawn it cannot complete',
  serve.status !== 0,
  `exit ${String(serve.status)}`,
);
const serveSaid = `${serve.stdout ?? ''}${serve.stderr ?? ''}`;
chk(
  '  and names the port and the real obstacle',
  serveSaid.includes(String(PORT)) && /another process|not a reticle daemon/i.test(serveSaid),
  serveSaid.trim().split('\n').slice(-1)[0] ?? '',
);
chk(
  '  and never claims the daemon was spawned',
  !serveSaid.includes('reticle_daemon_spawned'),
  serveSaid.includes('reticle_daemon_spawned') ? 'it still says spawned' : '',
);

const status = cli('status');
const statusSaid = `${status.stdout ?? ''}${status.stderr ?? ''}`;
chk(
  'status distinguishes "held by a stranger" from "nothing is here"',
  statusSaid.includes('"presence":"foreign"'),
  statusSaid.trim().split('\n').slice(-1)[0] ?? '',
);
chk('  and does not report the daemon as running', statusSaid.includes('"running":false'));

const doctor = cli('doctor');
const doctorSaid = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`;
chk(
  'doctor points at the port, not at the user’s app',
  /another process|not a reticle daemon/i.test(doctorSaid),
  doctorSaid
    .split('\n')
    .find((l) => l.includes('daemon '))
    ?.trim() ?? '',
);

await new Promise((resolve) => squatter.close(resolve));

// The control. Every assertion above is worthless if the same output appears on a FREE port — that
// would mean the commands are simply pessimistic rather than observant.
await freePortSafely(PORT);
const freeStatus = cli('status');
const freeSaid = `${freeStatus.stdout ?? ''}${freeStatus.stderr ?? ''}`;
chk(
  'a genuinely free port is reported as free, not as foreign',
  freeSaid.includes('"presence":"free"'),
  freeSaid.trim().split('\n').slice(-1)[0] ?? '',
);

console.log(
  `\n${fail === 0 ? '✅ DAEMON PORT HONESTY VERIFIED' : '❌ DAEMON PORT HONESTY FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
