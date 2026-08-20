import type { FileSystemPort } from '../project/fs-port.js';
import { log } from '../log.js';
import { isValidSessionId } from '../project/reticle-dir.js';
import { JournalRecorder, type JournalReader } from './journal-recorder.js';
import { SessionJournal } from './session-journal.js';

/** The minimal Session surface the journal attachment needs (Session satisfies it structurally). */
export interface JournalTarget {
  readonly id: string;
  /** Milliseconds since the session connected — the recorder's injected clock. */
  elapsed(): number;
  setJournal(recorder: JournalRecorder, reader?: JournalReader): void;
}

interface JournalAttachDeps {
  fs: FileSystemPort;
  reticleRoot: string;
  /** Journaling is on by default; the opt-out (`.reticle.json` journal:false / env) sets this false. */
  enabled: boolean;
}

/**
 * Build the per-session journal attachment the bridge fires on session creation. Off when disabled;
 * skips a session whose id is not a safe path segment (never crashes the live session over a
 * journaling concern). The recorder's clock is the session's own elapsed time.
 *
 * That skip used to be SILENT, which is the part that mattered. The id becomes a directory name, so
 * one that is not a safe path segment cannot be journalled — but the session itself connects and
 * drives perfectly well, so the only observable difference is that the durable causal record for it
 * does not exist. Every query that reads back through the journal then returns nothing, and nothing
 * anywhere says why. An app self-assigning an unusual id gets a quietly degraded session; a hostile
 * one gets the same, which is why this is worth a line either way. Nothing escapes the directory —
 * the guard holds, and that is exactly why the failure is invisible rather than loud.
 */
export function makeJournalAttach(deps: JournalAttachDeps): (session: JournalTarget) => void {
  return (session) => {
    if (!deps.enabled) return;
    if (!isValidSessionId(session.id)) {
      log('journal_skipped_unsafe_session_id', { sessionId: session.id });
      return;
    }
    const journal = new SessionJournal(deps.fs, deps.reticleRoot, session.id);
    // Same SessionJournal is both the write sink and the read fall-through for queries after eviction.
    session.setJournal(new JournalRecorder(journal, { now: () => session.elapsed() }), journal);
  };
}
