import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';

/**
 * install/install.sh, run for real against a stub npm and a stub `reticle`.
 *
 * The launcher is the first thing anybody runs and nothing executed it: two of its branches ended
 * the install on cases a user meets every day. A global npm folder that needs sudo (EACCES) died with
 * npm's log, and a global bin that is not on PATH in the current shell died AFTER the package was on
 * disk, so no coding agent was registered either. And the closing told every machine to "restart
 * your coding agent", including the ones with none.
 *
 * POSIX sh only; the PowerShell twin is driven by the install sandbox and CI's Windows jobs.
 */
const SCRIPT = join(REPO_ROOT, 'install', 'install.sh');

interface Sandbox {
  /** npm refuses a global install with EACCES unless `--prefix` is given. */
  eacces?: boolean;
  /** The global bin npm installs into is on PATH. */
  onPath?: boolean;
  /** The `RETICLE_INSTALL` line the stub CLI prints; undefined = an older CLI that prints none. */
  result?: string;
  /** Write a package.json where the installer runs. */
  inApp?: boolean;
  shell?: string;
  /** An older `reticle` that comes first on PATH. */
  shadow?: boolean;
  /** npm fails with this error code (a network or certificate failure). */
  npmError?: string;
}

function runInstaller(box: Sandbox): { code: number | null; out: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'install-launcher-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const prefix = join(root, 'global');
  const cwd = join(root, 'cwd');
  for (const dir of [home, bin, prefix, cwd]) mkdirSync(dir, { recursive: true });
  if (true === box.inApp) writeFileSync(join(cwd, 'package.json'), '{}');
  symlinkSync(process.execPath, join(bin, 'node'));
  if (true === box.shadow) {
    writeFileSync(join(bin, 'reticle'), '#!/bin/sh\necho OLD-RETICLE-RAN\n');
    chmodSync(join(bin, 'reticle'), 0o755);
  }
  const reticle = join(root, 'reticle-stub');
  writeFileSync(
    reticle,
    [
      '#!/bin/sh',
      'echo "  ✓ claude-code"',
      ...(box.result === undefined ? [] : [`echo "${box.result}"`]),
      'exit 0',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      `if [ "$1 $2" = "prefix -g" ]; then echo "${prefix}"; exit 0; fi`,
      ...(box.npmError === undefined ? [] : [`echo "npm error code ${box.npmError}" >&2; exit 1`]),
      `if [ "$1 $2" = "config get" ]; then echo "https://registry.npmjs.org/"; exit 0; fi`,
      `p="${prefix}"`,
      'while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && { p="$2"; custom=1; }; shift; done',
      `if [ "${true === box.eacces ? '1' : ''}" = 1 ] && [ -z "$custom" ]; then echo "npm error code EACCES" >&2; echo "npm error syscall mkdir" >&2; exit 243; fi`,
      'mkdir -p "$p/bin" && cp "' + reticle + '" "$p/bin/reticle" && chmod +x "$p/bin/reticle"',
    ].join('\n'),
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const path =
    true === box.shadow
      ? [bin, join(prefix, 'bin'), '/usr/bin', '/bin']
      : [...(false === box.onPath ? [] : [join(prefix, 'bin')]), bin, '/usr/bin', '/bin'];
  const r = spawnSync(box.shell ?? '/bin/sh', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: path.join(':'),
      SHELL: '/bin/zsh',
      // Outbound off: the prompt is the bundled copy and nothing is fetched.
      RETICLE_TELEMETRY: '0',
    },
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, home };
}

describe.skipIf('win32' === process.platform)('install.sh', () => {
  it('installs into a folder of its own when npm needs sudo, and registers the agents', () => {
    const { code, out, home } = runInstaller({
      eacces: true,
      result: 'RETICLE_INSTALL agents=1 app=none',
    });
    expect(code).toBe(0);
    expect(existsSync(join(home, '.reticle', 'npm', 'bin', 'reticle'))).toBe(true);
    expect(out).toContain('Registered with the coding agents');
    expect(out).not.toContain('was not installed');
    expect(out).toContain('export PATH="$HOME/.reticle/npm/bin:$PATH"');
  });

  it('finishes when the global bin is not on PATH, and prints the line that puts it there', () => {
    const { code, out } = runInstaller({
      onPath: false,
      result: 'RETICLE_INSTALL agents=1 app=none',
    });
    expect(code).toBe(0);
    expect(out).toContain('Registered with the coding agents');
    expect(out).toMatch(/export PATH="[^"]+\/bin:\$PATH"/);
    expect(out).toContain('.zshrc');
  });

  it('runs the CLI it just installed, not an older one first on PATH, and says so', () => {
    const { code, out } = runInstaller({
      shadow: true,
      result: 'RETICLE_INSTALL agents=1 app=none',
    });
    expect(code).toBe(0);
    expect(out).not.toContain('OLD-RETICLE-RAN');
    expect(out).toContain('another install');
  });

  it('names a registry it cannot reach, and what to set behind a proxy', () => {
    const { code, out } = runInstaller({ npmError: 'ECONNREFUSED' });
    expect(code).toBe(1);
    expect(out).toContain('could not reach');
    expect(out).toContain('npm config set proxy');
  });

  it('names a proxy that intercepts TLS, and the certificate setting', () => {
    const { out } = runInstaller({ npmError: 'SELF_SIGNED_CERT_IN_CHAIN' });
    expect(out).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('does not tell a machine with no coding agent to restart one', () => {
    const { code, out } = runInstaller({ result: 'RETICLE_INSTALL agents=0 app=none' });
    expect(code).toBe(0);
    expect(out).not.toContain('Restart it');
    expect(out).not.toContain('Registered with the coding agents');
    expect(out).toContain('No coding agent');
    expect(out).toContain('reticle init');
  });

  it('says "here" to somebody already standing in their app', () => {
    const { out } = runInstaller({ inApp: true, result: 'RETICLE_INSTALL agents=1 app=here' });
    expect(out).toContain('in this folder');
    expect(out).not.toContain('cd your-app');
  });

  it('never shows the machine line, and keeps the generic steps for an older CLI', () => {
    const shown = runInstaller({ result: 'RETICLE_INSTALL agents=1 app=none' }).out;
    expect(shown).not.toContain('RETICLE_INSTALL');
    const older = runInstaller({});
    expect(older.code).toBe(0);
    expect(older.out).toContain('Restart it');
    expect(older.out).toContain('cd your-app');
  });

  it('parses and runs under dash, the /bin/sh of Debian and Ubuntu', () => {
    if (!existsSync('/bin/dash')) return;
    const { code, out } = runInstaller({
      shell: '/bin/dash',
      result: 'RETICLE_INSTALL agents=0 app=here',
    });
    expect(code).toBe(0);
    expect(out).toContain('in this folder');
  });
});
