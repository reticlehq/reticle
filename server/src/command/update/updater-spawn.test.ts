import { describe, expect, it } from 'vitest';
import { npmSpawn } from './updater.js';
import { NodePlatform } from '@/machine/platform.js';

/**
 * `reticle update` is the channel every other fix reaches a user through, and on Windows it could
 * not run at all.
 *
 * `npm` on Windows is `npm.cmd`, and since the CVE-2024-27980 fix -- in every supported Node --
 * spawning a `.cmd` without a shell throws EINVAL. This repo already paid for that lesson once, in
 * `init/src/node-io.ts`: `reticle setup mcp` probed for the Claude CLI with a bare `execFileSync`,
 * the probe threw, and the installer told the user their machine had no Claude Code on it. The same
 * shape survived here, where the failure is worse: a user stranded on an old version, silently,
 * with no way to reach the fix that would have helped them.
 *
 * The platform is a parameter so this fails HERE rather than only on a machine nobody runs.
 */
describe('how the updater spawns npm', () => {
  const args = ['install', '-g', '@reticlehq/server@3.2.0'];

  it('spawns npm directly everywhere a shell is not required', () => {
    const spawn = npmSpawn(args, 'darwin');
    expect(spawn).toEqual({ file: 'npm', argv: args, shell: false });
  });

  /** The defect, as a test: no shell on Windows is an EINVAL, not an install. */
  it('goes through a shell on Windows, because npm.cmd cannot be spawned without one', () => {
    const spawn = npmSpawn(args, NodePlatform.WINDOWS);
    expect(spawn.shell).toBe(true);
    expect(spawn.file.startsWith('npm.cmd ')).toBe(true);
    // Everything moves into the command string: argv beside `shell: true` is ignored by cmd.exe.
    expect(spawn.argv).toEqual([]);
  });

  /**
   * A shell turns "these arguments are internal" into "these arguments are whatever the registry
   * said", since the version in the package spec comes from a fetch.
   */
  it('quotes an argument a shell would otherwise interpret', () => {
    const spawn = npmSpawn(
      ['install', '-g', '@reticlehq/server@1.0.0 & calc'],
      NodePlatform.WINDOWS,
    );
    expect(spawn.file).toContain('"@reticlehq/server@1.0.0 & calc"');
  });

  it('keeps an ordinary argument unquoted', () => {
    expect(npmSpawn(args, NodePlatform.WINDOWS).file).toContain('@reticlehq/server@3.2.0');
  });
});
