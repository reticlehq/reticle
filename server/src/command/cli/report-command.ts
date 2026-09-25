/**
 * `reticle report [--session <id>] [--hook]` — what this project's latest session claimed, and what held.
 *
 * Read from disk, with no daemon: the journal is on disk, and a Stop hook has to answer in the second
 * after the agent stops, when there may be nothing running to ask. The fold is `gapSummary`, the same
 * one `reticle_context` serves, so the terminal and the agent cannot be told two different stories.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { gapSummary } from '@/judgement/runs/artifact/gap-summary.js';
import { SessionJournal } from '@/memory/journal/session-journal.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { gapHookLine, gapReportLines } from '@/judgement/runs/artifact/gap-report.js';

/**
 * A session last written longer ago than this is not the turn a hook is asking about.
 *
 * ponytail: a fixed window, not a turn boundary — the Stop hook is not told when the turn began. A
 * drive older than an hour reads as "no claim this session", which errs toward saying so.
 */
const HOOK_WINDOW_MS = 60 * 60 * 1000;

export interface ReportInput {
  cwd: string;
  now: number;
  /** Did the working tree change? The hook stays silent on a turn that edited nothing. */
  treeChanged: boolean;
  session?: string;
  hook?: boolean;
}

interface Found {
  id: string;
  writtenAt: number;
}

/** The session whose action ledger was written most recently, if any. */
function newestSession(root: string): Found | undefined {
  const sessionsDir = join(root, ReticleDir.SESSIONS_SUBDIR);
  if (!existsSync(sessionsDir)) return undefined;
  let newest: Found | undefined;
  for (const id of readdirSync(sessionsDir)) {
    const ledger = join(sessionsDir, id, ReticleDir.JOURNAL_ACTIONS_FILE);
    if (!existsSync(ledger)) continue;
    const writtenAt = statSync(ledger).mtimeMs;
    if (newest === undefined || writtenAt > newest.writtenAt) newest = { id, writtenAt };
  }
  return newest;
}

export async function reportFor(input: ReportInput): Promise<{ lines: string[] }> {
  if (true === input.hook && !input.treeChanged) return { lines: [] };
  const root = join(input.cwd, ReticleDir.ROOT);
  const found =
    input.session === undefined ? newestSession(root) : { id: input.session, writtenAt: input.now };
  const current =
    found !== undefined && (true !== input.hook || input.now - found.writtenAt <= HOOK_WINDOW_MS)
      ? found
      : undefined;
  const actions =
    current === undefined
      ? []
      : await new SessionJournal(createNodeFileSystem(), root, current.id).readActions();
  const gap = gapSummary(actions);
  if (true === input.hook) {
    const line = gapHookLine(gap);
    return { lines: line === undefined ? [] : [line] };
  }
  const header = current === undefined ? [] : [`session ${current.id}`];
  return { lines: [...header, ...gapReportLines(gap)] };
}

/** Uncommitted changes in `cwd`. Outside a git repository nothing can say, so it answers yes. */
function treeChanged(cwd: string): boolean {
  try {
    return '' !== execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return true;
  }
}

/**
 * The command. As a hook it prints Claude Code's `systemMessage` shape and always exits 0: it is
 * print-only by design, so the human sees the gap and the agent is never blocked by it.
 */
export async function handleReport(session: string | undefined, hook: boolean): Promise<void> {
  const cwd = process.cwd();
  let lines: string[];
  try {
    ({ lines } = await reportFor({
      cwd,
      now: Date.now(),
      treeChanged: hook ? treeChanged(cwd) : true,
      ...(session === undefined ? {} : { session }),
      hook,
    }));
  } catch (error) {
    // A hook that throws turns the agent's stop into an error the user did not cause; it says nothing
    // instead. Run by hand, the reason is the answer (an id that is not a session, a journal it
    // could not read), so it is printed and the exit is non-zero.
    if (hook) return;
    process.stderr.write(
      `reticle report: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (0 === lines.length) return;
  process.stdout.write(
    hook ? `${JSON.stringify({ systemMessage: lines.join('\n') })}\n` : `${lines.join('\n')}\n`,
  );
}
