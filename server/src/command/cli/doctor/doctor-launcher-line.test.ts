import { describe, expect, it } from 'vitest';
import { launcherLine } from './doctor-launcher-line.js';

/**
 * An agent config can start Reticle from an installed copy (`node <path> mcp`). When that copy is
 * removed, the agent shows the server as failed and gives no reason. Doctor names the path and the
 * command that writes a working entry.
 */
describe('the launcher row', () => {
  const GONE = '/old/lib/node_modules/@reticlehq/server/bin/reticle.js';
  const HERE = '/usr/local/lib/node_modules/@reticlehq/server/bin/reticle.js';
  const exists = (p: string): boolean => HERE === p;

  it('names a registered launcher that does not exist, and the fix', () => {
    const line = launcherLine(
      [{ client: 'cursor', entry: { command: 'node', args: [GONE, 'mcp'] } }],
      exists,
    );
    expect(line).toContain('✗');
    expect(line).toContain(GONE);
    expect(line).toContain('cursor');
    expect(line).toContain('setup mcp');
  });

  it('tells a Claude Code user to remove the entry first, because setup keeps an existing one', () => {
    const line = launcherLine(
      [{ client: 'claude-code', entry: { command: 'node', args: [GONE, 'mcp'] } }],
      exists,
    );
    expect(line).toContain('claude mcp remove reticle');
  });

  it('reads an OpenCode command array', () => {
    const line = launcherLine(
      [{ client: 'opencode', entry: { type: 'local', command: ['node', GONE, 'mcp'] } }],
      exists,
    );
    expect(line).toContain(GONE);
  });

  it('prints nothing when the launcher exists, for npx, and for an entry that is not ours', () => {
    expect(
      launcherLine(
        [
          { client: 'cursor', entry: { command: 'node', args: [HERE, 'mcp'] } },
          { client: 'warp', entry: { command: 'npx', args: ['@reticlehq/server@3.8.2', 'mcp'] } },
          { client: 'zed', entry: { command: 'node', args: ['/my/build/cli.js', 'mcp'] } },
          { client: 'amp', entry: 'not an object' },
        ],
        exists,
      ),
    ).toBeUndefined();
  });
});
