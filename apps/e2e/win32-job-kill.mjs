#!/usr/bin/env node
// Windows only. Evidence probe, not a gate: does a daemon started the way spawnDaemon starts it
// (server/src/command/daemon/daemon.ts: spawn with detached: true, stdio to a file) die when the
// Job Object of the process that started it closes with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE?
// libuv sets DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP for detached, but not
// CREATE_BREAKAWAY_FROM_JOB, so the child stays in the job of its parent.
//
// The arm `real-spawn-daemon` calls the real spawnDaemon from the built server (run `pnpm build`
// first). It must survive the job close, answer /status, and write its log. If not, the exit is 1.
//
// Usage: node apps/e2e/win32-job-kill.mjs
// Output: one line for each arm, `ARM <name>: survived|killed|spawn-failed:<detail>`.
// .github/workflows/win32-job-probe.yml runs it on windows-latest.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const HELPER = join(dirname(SCRIPT), 'win32-job-kill.ps1');
const REPO = join(dirname(SCRIPT), '..', '..');
const REAL_ARM = 'real-spawn-daemon';
// Not the battery port (14400) and not a user daemon port (4400).
const REAL_PORT = 14471;
const READY_EVENT = 'reticle_daemon_ready';
const KILL_ON_JOB_CLOSE = 0x2000;
const BREAKAWAY_OK = 0x800;
const SILENT_BREAKAWAY_OK = 0x1000;

function powershell(args) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args],
    { encoding: 'utf8' },
  ).trim();
}

function quote(arg) {
  return `"${arg}"`;
}

// The child is the stand-in daemon: it records its own pid, then stays alive.
function runChild(pidFile) {
  writeFileSync(pidFile, String(process.pid));
  setInterval(() => {}, 60_000);
}

// How the parent starts the child, for each arm. Each start passes the pid file, and the child
// writes its own pid there, so arms that hide the pid (cmd start, WMI) are still checkable.
const STARTERS = {
  'plain-detached': (pidFile, logFd) => {
    spawn(process.execPath, [SCRIPT, '--child', pidFile], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    }).unref();
  },
  'cmd-start-b': (pidFile, logFd) => {
    // Verbatim: Node would escape the empty title `""` that `start` needs.
    const inner = [process.execPath, SCRIPT, '--child', pidFile].map(quote).join(' ');
    spawn('cmd.exe', ['/d', '/s', '/c', `"start "" /b ${inner}"`], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsVerbatimArguments: true,
    }).unref();
  },
  'wmi-create': (pidFile) => {
    const commandLine = [process.execPath, SCRIPT, '--child', pidFile].map(quote).join(' ');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replaceAll("'", "''")}' }; if ($r.ReturnValue -ne 0) { exit [int]$r.ReturnValue }`,
    ]);
  },
  // The product path: spawnDaemon chooses the start. The pid file gets the pid from its pidfile.
  [REAL_ARM]: async (pidFile) => {
    const daemon = join(REPO, 'server', 'dist', 'command', 'daemon', 'daemon.js');
    const { spawnDaemon, readPid } = await import(pathToFileURL(daemon).href);
    const stateDir = realStateDir(dirname(pidFile));
    process.env.RETICLE_STATE_DIR = stateDir;
    process.env.RETICLE_TELEMETRY = '0';
    const cli = join(REPO, 'server', 'bin', 'reticle.js');
    if (!spawnDaemon(process.execPath, cli, ['_daemon', '--port', String(REAL_PORT)], REAL_PORT)) {
      writeFileSync(pidFile, 'spawnDaemon-returned-false');
      return;
    }
    writeFileSync(pidFile, String(readPid(REAL_PORT, stateDir) ?? 'no-pid-in-pidfile'));
  },
  'breakaway-flag': (pidFile) => {
    const commandLine = [process.execPath, SCRIPT, '--child', pidFile].map(quote).join(' ');
    const result = powershell(['-Mode', 'breakaway-spawn', '-Cmd', commandLine]);
    if (result.startsWith('error:')) {
      writeFileSync(pidFile, `createprocess-${result}`);
    }
  },
};

function realStateDir(dir) {
  return join(dir, 'real-state');
}

async function runParent(arm, dir) {
  const pidFile = join(dir, `${arm}.pid`);
  const goFile = join(dir, `${arm}.go`);
  const deadline = Date.now() + 30_000;
  while (!existsSync(goFile)) {
    if (Date.now() > deadline) {
      writeFileSync(pidFile, 'parent-never-got-go');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const logFd = openSync(join(dir, `${arm}.log`), 'a');
  try {
    await STARTERS[arm.split('@')[0]](pidFile, logFd);
  } catch (error) {
    writeFileSync(pidFile, `start-threw-${String(error?.status ?? error?.code ?? 'error')}`);
    return;
  }
  // Wait for the child to record its pid. The parent then exits, like `reticle mcp` does.
  while (Date.now() < deadline) {
    if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  writeFileSync(pidFile, 'child-never-wrote-pid');
}

// Arm name = starter@job flags. The suffix names the job limits, so the output is self-describing.
const ARMS = [
  ['plain-detached@kill', KILL_ON_JOB_CLOSE],
  ['cmd-start-b@kill', KILL_ON_JOB_CLOSE],
  ['wmi-create@kill', KILL_ON_JOB_CLOSE],
  ['breakaway-flag@kill', KILL_ON_JOB_CLOSE],
  ['breakaway-flag@kill+breakaway-ok', KILL_ON_JOB_CLOSE | BREAKAWAY_OK],
  ['plain-detached@kill+silent-breakaway-ok', KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK],
  [`${REAL_ARM}@kill`, KILL_ON_JOB_CLOSE],
];

function runProbe() {
  if (process.platform !== 'win32') {
    process.stderr.write('win32-job-kill: Windows only.\n');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'reticle-job-probe-'));
  process.stdout.write(`AMBIENT job of this probe: ${powershell(['-Mode', 'ambient'])}\n`);
  let realProved = false;
  for (const [arm, limits] of ARMS) {
    const real = arm.startsWith(REAL_ARM);
    let outcome;
    try {
      outcome = powershell([
        ...(real ? ['-StatusPort', String(REAL_PORT)] : []),
        '-Mode',
        'probe',
        '-Limits',
        limits.toString(16),
        '-Arm',
        arm,
        '-Node',
        process.execPath,
        '-Script',
        SCRIPT,
        '-Dir',
        dir,
      ]);
    } catch (error) {
      outcome = `spawn-failed:helper-error ${String(error?.stderr ?? error).trim().split('\n')[0]}`;
    }
    process.stdout.write(`ARM ${arm}: ${outcome}\n`);
    if (real) {
      const log = join(realStateDir(dir), `daemon-${REAL_PORT}.log`);
      const logged = existsSync(log) && readFileSync(log, 'utf8').includes(READY_EVENT);
      process.stdout.write(`LOG ${arm}: ${logged ? 'has-ready' : 'missing-ready'}\n`);
      realProved = 'survived' === outcome && logged;
    }
  }
  if (!realProved) {
    process.stderr.write(`win32-job-kill: ${REAL_ARM} did not survive the job close.\n`);
    process.exit(1);
  }
}

const [role, first, second] = process.argv.slice(2);
if (role === '--child') {
  runChild(first);
} else if (role === '--parent') {
  await runParent(first, second);
} else {
  runProbe();
}
