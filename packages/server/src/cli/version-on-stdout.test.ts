import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { SERVER_VERSION } from '../version/server-version.js';

/**
 * `reticle version` prints the version somewhere a script can read it.
 *
 * Every diagnostic in this repository asks for the version first, because the usual surprise is that
 * `npx` resolved a different build than the one somebody thinks they are running. That answer is
 * only useful if it can be copied into a bug report or captured in a shell.
 *
 * It used to exist only as a structured event on stderr. In a terminal that looks fine -- stderr is
 * right there on the screen -- so nothing ever seemed wrong. But `V=$(reticle version)` came back
 * empty, which is the exact shape somebody reaches for when writing an issue template or a CI check.
 *
 * The event stays. Machine-readable events all go to stderr and that consistency is worth keeping;
 * this only adds the plain line to stdout, where the convention for `--version` has always been.
 *
 * Runs the real binary, because this is a claim about the assembled program: the same fix looked
 * complete at the unit level twice in this file's neighbourhood and was not.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'cli.js');

function run(...args: string[]): { stdout: string; stderr: string } {
  const stderrChunks: Buffer[] = [];
  const stdout = execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout, stderr: Buffer.concat(stderrChunks).toString() };
}

describe('the version is readable by a script, not only by a person', () => {
  it('prints the bare version on stdout', () => {
    expect(run('version').stdout.trim()).toBe(SERVER_VERSION);
  });

  it('answers the conventional flags the same way', () => {
    expect(run('--version').stdout.trim()).toBe(SERVER_VERSION);
    expect(run('-v').stdout.trim()).toBe(SERVER_VERSION);
  });

  it('is exactly the version and nothing else, so it can be compared', () => {
    // A prefix like "reticle 2.14.0" would need parsing, and every caller would parse it slightly
    // differently. One line, one value.
    expect(run('version').stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
