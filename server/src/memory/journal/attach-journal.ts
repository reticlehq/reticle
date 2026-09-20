import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { log } from '@/log.js';
import { isValidSessionId } from '@/memory/project/dir/reticle-dir.js';
import { JournalRecorder, type JournalReader } from './journal-recorder.js';
import { SessionJournal } from './session-journal.js';

/** The minimal Session surface the journal attachment needs (Session satisfies it structurally). */
export interface JournalTarget {
  readonly id: string;
  /**
   * The `.reticle` this session's artifacts belong in, stamped on session-create before this runs.
   *
   * The journal used to go to the daemon's own root — wherever the agent was launched — while the
   * run artifact written at teardown already used this one. The journal is the worse half to
   * misroute: it carries URLs, request and response bodies and DOM text from the app under test, so
   * a daemon started in a backend wrote that app's traffic into a repository nobody instrumented,
   * and the `.reticle/.gitignore` meant to keep journals out of a shared repo was being written into
   * the OTHER tree. Undefined only when no project could be resolved, which keeps the old fallback.
   */
  readonly artifactRoot?: string | undefined;
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
 * The skip is LOGGED, because it is otherwise invisible: the session connects and drives perfectly
 * well, and the only difference is that its durable causal record does not exist, so every query
 * reading back through the journal returns nothing with no explanation.
 */
export function makeJournalAttach(deps: JournalAttachDeps): (session: JournalTarget) => void {
  return (session) => {
    if (!deps.enabled) return;
    if (!isValidSessionId(session.id)) {
      log('journal_skipped_unsafe_session_id', { sessionId: session.id });
      return;
    }
    const journal = new SessionJournal(
      deps.fs,
      session.artifactRoot ?? deps.reticleRoot,
      session.id,
    );
    // Same SessionJournal is both the write sink and the read fall-through for queries after eviction.
    session.setJournal(new JournalRecorder(journal, { now: () => session.elapsed() }), journal);
  };
}
