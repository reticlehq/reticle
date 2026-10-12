/**
 * App notes: what an agent learned about TARGETING this app, kept for the next session.
 *
 * "The composer is a contenteditable labelled 'Ask a question'", "this app writes 'Trial' capitalised"
 * — facts an agent pays one failed verdict to learn, and the next agent on the same app pays again.
 * A note is written only after it was CONFIRMED (a later verdict that used it passed), so a guess
 * never becomes lore.
 *
 * Hints, never evidence. Nothing that decides a verdict reads this file; it is surfaced to the agent
 * in its first notices and in `reticle_context`, and an agent may use it to aim a check, never to
 * pass one. Local to `.reticle/` (checked in with the project, so a team shares it through git).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';

/** Most notes kept: the oldest drop first. A notebook, not a database. */
const MAX_NOTES = 30;

function pathOf(root: string): string {
  return join(root, ReticleDir.APP_NOTES_FILE);
}

/** The notes for the project at `root` (its `.reticle` directory). Never throws. */
export function readAppNotes(root: string): string[] {
  try {
    const path = pathOf(root);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const notes =
      'object' === typeof parsed && null !== parsed ? (parsed as { notes?: unknown }).notes : [];
    return Array.isArray(notes) ? notes.filter((n): n is string => 'string' === typeof n) : [];
  } catch {
    return [];
  }
}

/** Add a confirmed note; true when it was new. Never throws: a note is never why a call fails. */
export function addAppNote(root: string, note: string): boolean {
  try {
    const notes = readAppNotes(root);
    if (notes.includes(note) || !existsSync(root)) return false;
    const kept = [...notes, note].slice(-MAX_NOTES);
    writeFileSync(pathOf(root), `${JSON.stringify({ notes: kept }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
