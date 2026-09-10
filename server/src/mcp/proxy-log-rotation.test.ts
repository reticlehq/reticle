import { describe, expect, it } from 'vitest';
import { MAX_DAEMON_LOG_BYTES } from '../daemon/daemon.js';
import {
  PROXY_LOG_CHECK_BYTES,
  accountProxyLogWrite,
  recoverOversizedProxyLog,
} from './mcp-proxy.js';

/**
 * The proxy log was the one file in `~/.reticle` nothing ever bounded.
 *
 * Reported from the field: `proxy-4400.log` reached a third of a 460GB disk, and the first symptom
 * the user saw was the operating system failing to write files — builds, Docker and ordinary shell
 * commands broke with ENOSPC while every other file in the directory was under 50KB. The daemon log
 * on the same machine stayed small, because rotation existed and was wired to that file only.
 */
describe('proxy log rotation', () => {
  const ops = (size: number) => {
    const stats: string[] = [];
    const renames: { from: string; to: string }[] = [];
    return {
      stats,
      renames,
      fileSize: (p: string): number => {
        stats.push(p);
        return size;
      },
      renameFile: (from: string, to: string): void => void renames.push({ from, to }),
    };
  };

  it('does not stat the file on every write', () => {
    // The proxy logs from a reconnect loop. A stat per line is a syscall per line, which is exactly
    // the cost the counter exists to avoid.
    const deps = ops(0);
    let since = 0;
    for (let i = 0; i < 100; i++)
      since = accountProxyLogWrite(since, 100, '/x/proxy-4400.log', deps);
    expect(deps.stats).toEqual([]);
    expect(since).toBe(100 * 100);
  });

  it('checks and rolls over once the appended bytes add up', () => {
    const deps = ops(MAX_DAEMON_LOG_BYTES + 1);
    const since = accountProxyLogWrite(PROXY_LOG_CHECK_BYTES - 1, 1, '/x/proxy-4400.log', deps);
    expect(deps.renames).toEqual([{ from: '/x/proxy-4400.log', to: '/x/proxy-4400.log.1' }]);
    // Counter restarts, so the next check is another full interval away.
    expect(since).toBe(0);
  });

  it('leaves a log under the cap alone when the interval comes round', () => {
    const deps = ops(1024);
    accountProxyLogWrite(PROXY_LOG_CHECK_BYTES, 0, '/x/proxy-4400.log', deps);
    expect(deps.stats).toEqual(['/x/proxy-4400.log']);
    expect(deps.renames).toEqual([]);
  });

  it('checks often enough that the cap is a cap, not a suggestion', () => {
    expect(PROXY_LOG_CHECK_BYTES).toBeLessThan(MAX_DAEMON_LOG_BYTES);
  });
});

/**
 * Machines carrying one of these files exist NOW, and the user should not have to find it with `du`.
 */
describe('runaway proxy log recovery', () => {
  const ops = (size: number) => {
    const truncated: string[] = [];
    return {
      truncated,
      fileSize: (): number => size,
      truncateFile: (p: string): void => void truncated.push(p),
    };
  };

  it('leaves a log that is within the cap untouched', () => {
    const deps = ops(1024);
    expect(recoverOversizedProxyLog('/x/proxy-4400.log', deps)).toBe(0);
    expect(deps.truncated).toEqual([]);
  });

  it('truncates an already-runaway log in place and reports what it reclaimed', () => {
    // In place, not renamed and not unlinked: a rename moves the bytes without reclaiming them, and
    // a file still open in a running process keeps its blocks until the handle closes.
    const deps = ops(171 * 1024 * 1024 * 1024);
    expect(recoverOversizedProxyLog('/x/proxy-4400.log', deps)).toBe(171 * 1024 * 1024 * 1024);
    expect(deps.truncated).toEqual(['/x/proxy-4400.log']);
  });

  it('treats a missing log as nothing to reclaim rather than a startup failure', () => {
    const throwing = {
      fileSize: (): number => {
        throw new Error('ENOENT');
      },
      truncateFile: (): void => {
        throw new Error('unreachable');
      },
    };
    expect(() => recoverOversizedProxyLog('/x/proxy-4400.log', throwing)).not.toThrow();
    expect(recoverOversizedProxyLog('/x/proxy-4400.log', throwing)).toBe(0);
  });

  it('never lets housekeeping stop the proxy from starting', () => {
    const throwing = {
      fileSize: (): number => MAX_DAEMON_LOG_BYTES + 1,
      truncateFile: (): void => {
        throw new Error('EPERM');
      },
    };
    expect(() => recoverOversizedProxyLog('/x/proxy-4400.log', throwing)).not.toThrow();
    expect(recoverOversizedProxyLog('/x/proxy-4400.log', throwing)).toBe(0);
  });
});
