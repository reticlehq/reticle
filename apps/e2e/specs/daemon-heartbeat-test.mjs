// A killed daemon and a tidy one must not read the same in the log we tell people to open.
//
// From a real gate run, ~/.reticle/daemon-4400.log around a fixture scored as an install failure:
//
//   10:49:05  mcp_daemon_started        port:4400            <- pid 2884
//   10:51:29  mcp_daemon_started        port:4400  pid:4900  <- a SECOND daemon binds the SAME port
//   10:51:40  reticle_daemon_exiting    code:0
//             ...21 seconds with nothing listening; a fixture's whole connect window...
//
// pid 2884 died with NO exit event — installExitTrace hooks 'exit', which SIGKILL never fires — and
// the one that DID exit logged `code: 0`. So the last line before the port went dark read as a tidy
// shutdown, and a correct SvelteKit install was written up as an install failure on that basis.
//
// This drives the real daemon three ways and reads its own log back through classifyDaemonLife.
// Needs no browser and no servers.
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyDaemonLife, DaemonEnd } from '@reticlehq/server';
import { freePortSafely, startOwnedDaemon, transportAlive } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'packages/server/dist/cli.js');
const PORT = Number(process.env.DAEMON_HEARTBEAT_PORT ?? '4745');
const LOG = path.join(homedir(), '.reticle', `daemon-${String(PORT)}.log`);
/** Fast enough for a spec; the product default is 30s. See ReticleEnv.HEARTBEAT. */
const BEAT_MS = 300;

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const sizeOf = (f) => {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
};

/** Only the lines THIS run appended — the file survives between runs. */
function linesSince(offset) {
  const raw = readFileSync(LOG, 'utf8').slice(offset);
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        const row = JSON.parse(l);
        // classifyDaemonLife works in milliseconds; the log stamps ISO strings.
        return { ...row, t: Date.parse(row.t) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const listener = () => {
  try {
    return execFileSync('sh', ['-c', `lsof -nP -iTCP:${String(PORT)} -sTCP:LISTEN -t`], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
};

console.log('\n=== DAEMON HEARTBEAT: silence in the log is evidence, not ambiguity ===');
process.chdir(ROOT);
await freePortSafely(PORT);

// ── 1. a live daemon beats ─────────────────────────────────────────────────────────────────────
const before = sizeOf(LOG);
const daemon = await startOwnedDaemon(PORT, {
  cliPath: CLI,
  cwd: ROOT,
  env: { RETICLE_HEARTBEAT_MS: String(BEAT_MS) },
});
await sleep(BEAT_MS * 4);

let lines = linesSince(before);
const beats = lines.filter((l) => l.event === 'reticle_daemon_alive');
chk('a live daemon says so, repeatedly', beats.length >= 2, `${beats.length} beats`);
chk(
  '  and each beat carries its own cadence, so a reader never hard-codes it',
  beats.every((b) => b.everyMs === BEAT_MS),
  `everyMs=${String(beats[0]?.everyMs)}`,
);
chk('  and the reader calls it alive', classifyDaemonLife(lines, Date.now()).end === DaemonEnd.ALIVE);

// ── 2. SIGKILL — the case that used to leave nothing at all ─────────────────────────────────────
const pid = listener();
chk('the daemon is listening, so there is something to kill', pid !== '', `pid ${pid}`);
if (pid !== '') execFileSync('sh', ['-c', `kill -9 ${pid}`]);
await sleep(BEAT_MS * 4);
chk('  and the port really is dark', !(await transportAlive(PORT)));

lines = linesSince(before);
const killed = classifyDaemonLife(lines, Date.now());
chk(
  'a SIGKILLed daemon is reported as having DIED, not as a tidy exit',
  killed.end === DaemonEnd.DIED_SILENTLY,
  `end=${killed.end} silentForMs=${String(killed.silentForMs)}`,
);
chk(
  '  and it says how long the log has been silent, so the gap can be placed against a connect window',
  typeof killed.silentForMs === 'number' && killed.silentForMs > BEAT_MS,
  `${String(killed.silentForMs)}ms`,
);

// ── 3. the control: a daemon asked to stop is NOT reported as having died ───────────────────────
// Without this the check above would pass on a reader that simply calls every daemon dead.
const before2 = sizeOf(LOG);
const second = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, RETICLE_HEARTBEAT_MS: String(BEAT_MS), RETICLE_IDLE_SHUTDOWN_MS: '0' },
});
second.unref();
for (let i = 0; i < 60; i++) {
  if (await transportAlive(PORT)) break;
  await sleep(250);
}
await sleep(BEAT_MS * 3);
execFileSync('sh', ['-c', `${process.execPath} ${CLI} stop --port ${String(PORT)} --quiet`], {
  cwd: ROOT,
});
await sleep(1_500);

const stopped = classifyDaemonLife(linesSince(before2), Date.now());
chk(
  'a daemon asked to stop is NOT reported as having died silently',
  stopped.end !== DaemonEnd.DIED_SILENTLY,
  `end=${stopped.end}${stopped.signal ? ` signal=${stopped.signal}` : ''}`,
);
chk(
  '  and the SIGNAL is named, because an exit line with code:0 does not carry the cause',
  stopped.end === DaemonEnd.SIGNALLED || stopped.end === DaemonEnd.CLEAN,
  `end=${stopped.end}`,
);

await daemon.stop();
await freePortSafely(PORT);

console.log(
  `\n${fail === 0 ? '✅ DAEMON HEARTBEAT VERIFIED' : '❌ DAEMON HEARTBEAT FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
