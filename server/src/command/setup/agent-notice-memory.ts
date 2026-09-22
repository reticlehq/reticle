/**
 * Which "add the reticle entry by hand" lines have already been said on this machine.
 *
 * Two commands register agents, deliberately: the installer does it because it once reached fewer
 * clients than `init` and sent people to a project directory to finish a half-done job, and `init`
 * does it because that is where the project gets wired. Both then narrate the clients whose config
 * we refuse to rewrite -- a Zed settings file with comments in it, a Continue YAML somebody
 * formatted -- so a `curl | sh` followed by `reticle init` prints the same two paragraphs twice in
 * one sitting, and prints them again on every re-run after that, forever.
 *
 * The REGISTRATION stays in both places. The sentence is the thing that repeats, and it is a
 * sentence about a MACHINE rather than about a run: a config we will not rewrite stays un-rewritten
 * until somebody edits it, at which point the notice's own text changes and it is said again.
 *
 * Stamped by content, not by run. If the stamp cannot be read or written the notice simply prints,
 * which is the failure that costs a duplicate line rather than a missed instruction.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One client we could not write to, and why. */
export interface ManualNotice {
  readonly name: string;
  readonly file: string;
  readonly why: string;
}

/** Where the stamp lives, under the state home the caller resolves. */
export const NOTICE_MEMORY_BASENAME = 'agent-notices.json';

/** Identity of a notice: the same client, the same file, for the same reason. */
export function noticeKey(n: ManualNotice): string {
  return JSON.stringify([n.name, n.file, n.why]);
}

/** Pure. The notices `said` has not already recorded, in order, without repeats. */
export function unsaidNotices(
  said: readonly string[],
  notices: readonly ManualNotice[],
): ManualNotice[] {
  const seen = new Set(said);
  const out: ManualNotice[] = [];
  for (const n of notices) {
    const key = noticeKey(n);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Every key recorded before. An unreadable or malformed stamp reads as "nothing was said". */
export function readSaid(stateHome: string): string[] {
  try {
    const raw = readFileSync(join(stateHome, NOTICE_MEMORY_BASENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => 'string' === typeof k);
  } catch {
    return [];
  }
}

/** Record these keys beside whatever was there. A failed write costs a repeated line, nothing more. */
export function rememberSaid(stateHome: string, keys: readonly string[]): void {
  if (0 === keys.length) return;
  const merged = [...new Set([...readSaid(stateHome), ...keys])];
  try {
    mkdirSync(stateHome, { recursive: true });
    writeFileSync(join(stateHome, NOTICE_MEMORY_BASENAME), JSON.stringify(merged, null, 2));
  } catch {
    // Said once too often is the cost. Silence here is deliberate: a stamp that cannot be written
    // must not fail an install.
  }
}
