/**
 * Start the daemon outside the Windows Job Object of the process that starts it.
 *
 * A child of `spawn(..., { detached: true })` stays in the job of its parent. An agent host can run
 * `reticle mcp` in a job with KILL_ON_JOB_CLOSE, and the close of that job then kills the daemon
 * too. A process that WMI `Win32_Process.Create` starts is in no job of ours.
 *
 * WMI cannot give the new process our stdio or our env. So WMI starts a small launcher, and the
 * launcher does the same detached spawn as `spawnDaemon`: stdout and stderr go to the daemon log,
 * opened for append, and the env is ours. The daemon is a child of the launcher, so it is outside
 * the job too. The launcher reads the spawn spec from a file and writes the daemon pid to a file.
 *
 * The spec file is also the lock between the launcher and the fallback. The launcher claims it with
 * a rename before it starts anything. The parent removes it after the WMI call. Only one of the two
 * can win. If the parent wins, nothing started and the detached fallback is safe.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** What the launcher must start. */
export interface EscapeRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logPath: string;
  /** The spec file. The launcher writes the daemon pid to `<specPath>.pid`. */
  readonly specPath: string;
}

/**
 * `launched: false` means nothing started, so the caller can start the daemon another way.
 * `launched: true` with no pid means a daemon may start, but its pid is not known in time.
 */
export type EscapeResult = { launched: false } | { launched: true; pid?: number };

/**
 * The launcher, as `node -e` source. It has no double quote and no backslash, so it passes as one
 * Windows argument in double quotes. Its one argument is the spec path.
 */
export const JOB_ESCAPE_LAUNCHER = [
  "const fs=require('fs'),cp=require('child_process');",
  "const f=process.argv[1],t=f+'.taken';",
  'fs.renameSync(f,t);',
  "const s=JSON.parse(fs.readFileSync(t,'utf8'));",
  'fs.unlinkSync(t);',
  "const fd=fs.openSync(s.log,'a');",
  "const c=cp.spawn(s.command,s.args,{cwd:s.cwd,env:s.env,detached:true,stdio:['ignore',fd,fd]});",
  "c.on('error',()=>{});",
  'c.unref();',
  "fs.writeFileSync(f+'.tmp',String(c.pid));",
  "fs.renameSync(f+'.tmp',f+'.pid');",
].join('');

const PID_SUFFIX = '.pid';
/** How long the script waits for the launcher to report the daemon pid. */
const PID_WAIT_MS = 5000;
/** A hard limit on the whole PowerShell call: its start, the WMI call and the pid wait. */
const WMI_CALL_TIMEOUT_MS = 8000;
const POWERSHELL = 'powershell.exe';
const ENCODING_UTF16LE = 'utf16le';

/** A PowerShell single-quoted literal. */
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The PowerShell script: start the launcher through WMI, then wait for the pid file. */
export function wmiScript(request: EscapeRequest): string {
  const commandLine = `"${request.command}" -e "${JOB_ESCAPE_LAUNCHER}" "${request.specPath}"`;
  const pidPath = `${request.specPath}${PID_SUFFIX}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    // SW_HIDE, so the launcher opens no console window.
    '$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral(commandLine)}; CurrentDirectory = ${psLiteral(request.cwd)}; ProcessStartupInformation = $startup }`,
    `$deadline = (Get-Date).AddMilliseconds(${PID_WAIT_MS})`,
    `while (-not (Test-Path -LiteralPath ${psLiteral(pidPath)}) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }`,
  ].join('\n');
}

function runPowerShell(script: string): void {
  execFileSync(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, ENCODING_UTF16LE).toString('base64'),
    ],
    { stdio: 'ignore', timeout: WMI_CALL_TIMEOUT_MS, windowsHide: true },
  );
}

function removeIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function readLauncherPid(pidPath: string): number | undefined {
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start `request` through WMI. Never throws: every failure reads as `launched: false`, unless the
 * launcher already claimed the spec, which means it is starting the daemon.
 */
export function escapeJobViaWmi(
  request: EscapeRequest,
  run: (script: string) => void = runPowerShell,
): EscapeResult {
  const pidPath = `${request.specPath}${PID_SUFFIX}`;
  try {
    removeIfPresent(pidPath);
    writeFileSync(
      request.specPath,
      JSON.stringify({
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        log: request.logPath,
      }),
      // The spec holds the env. Only the user may read it, and it lives until the launcher reads it.
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    return { launched: false };
  }
  try {
    run(wmiScript(request));
  } catch {
    // PowerShell missing, blocked, failed or timed out. The spec says whether the launcher ran.
  }
  if (removeIfPresent(request.specPath)) {
    return { launched: false };
  }
  const pid = readLauncherPid(pidPath);
  removeIfPresent(pidPath);
  return pid === undefined ? { launched: true } : { launched: true, pid };
}
