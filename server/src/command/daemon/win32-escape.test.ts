import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeJobViaWmi, JOB_ESCAPE_LAUNCHER, type EscapeRequest } from './win32-escape.js';

/** A generous bound for a detached node child to start and write one line. Not a duration check. */
const CHILD_WRITE_TIMEOUT_MS = 15_000;

describe('escapeJobViaWmi', () => {
  let home: string;
  let request: EscapeRequest;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'reticle-wmi-test-'));
    request = {
      command: 'C:\\node\\node.exe',
      args: ['C:\\reticle\\cli.js', '_daemon'],
      cwd: home,
      env: { PATH: 'x' },
      logPath: join(home, 'daemon-4400.log'),
      specPath: join(home, 'daemon-4400.spawn.json'),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** What the launcher does when WMI starts it: claim the spec, then report the daemon pid. */
  function launcherRuns(pid?: number): void {
    renameSync(request.specPath, `${request.specPath}.taken`);
    unlinkSync(`${request.specPath}.taken`);
    if (pid !== undefined) {
      writeFileSync(`${request.specPath}.pid`, String(pid));
    }
  }

  it('hands the launcher a spec with the command, the log and the env', () => {
    let spec: unknown;
    let script = '';
    escapeJobViaWmi(request, (s) => {
      script = s;
      spec = JSON.parse(readFileSync(request.specPath, 'utf8'));
      launcherRuns(4242);
    });
    expect(spec).toEqual({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      log: request.logPath,
    });
    expect(script).toContain('Win32_Process');
    expect(script).toContain(`"${request.command}" -e "`);
  });

  it('returns the daemon pid that the launcher reports', () => {
    expect(escapeJobViaWmi(request, () => launcherRuns(4242))).toEqual({
      launched: true,
      pid: 4242,
    });
    expect(existsSync(`${request.specPath}.pid`)).toBe(false);
  });

  it('reports nothing launched when the launcher never claimed the spec', () => {
    const result = escapeJobViaWmi(request, () => {
      throw new Error('powershell.exe ENOENT');
    });
    expect(result).toEqual({ launched: false });
    expect(existsSync(request.specPath)).toBe(false);
  });

  it('reports a launch with no pid when the launcher claimed the spec but wrote no pid', () => {
    const result = escapeJobViaWmi(request, () => {
      launcherRuns();
      throw new Error('timed out');
    });
    expect(result).toEqual({ launched: true });
  });
});

describe('JOB_ESCAPE_LAUNCHER', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'reticle-launcher-test-'));
  });

  afterEach(() => {
    // The detached child can still hold the log on Windows just after its write: retry the delete.
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });

  it('has no double quote or backslash, so it passes as one Windows argument', () => {
    expect(JOB_ESCAPE_LAUNCHER).not.toMatch(/["\\]/);
  });

  it('starts the command with its output appended to the log, and writes its pid', async () => {
    const specPath = join(home, 'spec.json');
    const logPath = join(home, 'daemon.log');
    writeFileSync(logPath, 'before\n');
    writeFileSync(
      specPath,
      JSON.stringify({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.MARK ?? "")'],
        cwd: home,
        env: { MARK: 'from-daemon' },
        log: logPath,
      }),
    );
    execFileSync(process.execPath, ['-e', JOB_ESCAPE_LAUNCHER, specPath]);

    expect(existsSync(specPath)).toBe(false);
    expect(Number(readFileSync(`${specPath}.pid`, 'utf8'))).toBeGreaterThan(0);
    // The child runs detached, so its write lands after the launcher exits.
    await vi.waitFor(() => expect(readFileSync(logPath, 'utf8')).toBe('before\nfrom-daemon'), {
      timeout: CHILD_WRITE_TIMEOUT_MS,
    });
  });
});
