import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { ReviewMark } from './review-store.js';

/** One note as it lands on disk: the mark without its session-local id and clock. */
type StoredNote = Omit<ReviewMark, 'id' | 'at'>;

/** What `.reticle/notes.json` holds. Keyed by content, so a note survives the session it was made in. */
export interface NotesFile {
  notes: Record<string, StoredNote>;
}

/** Enough for a project's review history; the oldest fall off first. */
const MAX_NOTES = 500;

/**
 * Mark ids (`m1`, `m2`, …) restart with the daemon, so they cannot name a note across sessions.
 * The route, anchor and words can: the same complaint on the same element is the same note.
 */
export function noteKey(mark: Pick<ReviewMark, 'route' | 'anchor' | 'note'>): string {
  return createHash('sha256')
    .update(`${mark.route ?? ''}\n${mark.anchor}\n${mark.note}`)
    .digest('hex')
    .slice(0, 16);
}

function read(path: string): NotesFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NotesFile>;
    return { notes: 'object' === typeof parsed.notes && null !== parsed.notes ? parsed.notes : {} };
  } catch {
    return { notes: {} };
  }
}

/**
 * Merge one session's marks into the project's notes file, so the HUD notes a human left reach the
 * platform with the rest of `.reticle/` instead of dying with the session that held them.
 *
 * Never throws: a note that cannot be written must not break the event that carried it.
 */
export function recordNotes(reticleRoot: string | undefined, marks: readonly ReviewMark[]): void {
  if (reticleRoot === undefined || 0 === marks.length) return;
  const path = join(reticleRoot, ReticleDir.NOTES_FILE);
  try {
    const held = read(path).notes;
    for (const { id: _id, at: _at, ...note } of marks) {
      const key = noteKey(note);
      // Re-inserted so a note touched now counts as the newest when the oldest are dropped.
      delete held[key];
      held[key] = note;
    }
    const keys = Object.keys(held);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_NOTES))) delete held[stale];
    mkdirSync(reticleRoot, { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ notes: held } satisfies NotesFile, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch {
    // Disk full or read-only checkout: the note is still in the session, just not on the platform.
  }
}
