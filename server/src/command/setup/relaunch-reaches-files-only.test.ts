/**
 * `--relaunch` has to survive `--files-only`.
 *
 * The restart question belongs to whoever just installed, and `--files-only` is the mode an agent
 * uses when the app is already running — so the route that most needs the answer was the one route
 * that returned before the decision was made. The flag parsed, exited zero, and printed nothing.
 */
import { describe, expect, it } from 'vitest';
import { continueAfterInit } from './init/init-runtime.js';

const RESULT = { ok: true, applied: 1, manual: 0 } as const;

const runFilesOnly = async (): Promise<string[]> => {
  const lines: string[] = [];
  await continueAfterInit(
    { filesOnly: true, relaunch: true, port: undefined, dryRun: false },
    { ...RESULT },
    { print: (l) => lines.push(l) },
    process.cwd(),
  );
  return lines;
};

describe('relaunch under --files-only', () => {
  it('says something about the restart rather than accepting the flag in silence', async () => {
    const said = (await runFilesOnly()).join('\n');
    // Any of the four outcomes is a real answer; silence is the bug.
    expect(said).toMatch(/resume|restart|refusing to restart|does not tell a child process/i);
  });
});
