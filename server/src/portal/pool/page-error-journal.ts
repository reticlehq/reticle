/**
 * Journal the uncaught page errors the SDK was never installed in time to see.
 *
 * An app whose module graph throws during the first navigation fires its `error` event while the
 * page still has no Reticle SDK in it — the zero-install reader is only evaluated after `goto`
 * resolves. The agent then saw a blank page and a bare console-error count, and had to re-run the
 * app under `--enable-logging` to learn why (#1966). The pool's Playwright handle is attached
 * before the navigation, so the server is the one witness that cannot miss the throw.
 *
 * The pool hands errors here with the lease id. The session for that lease usually does not exist
 * yet, so errors buffer per lease and flush the moment the session connects
 * (`bridge.attachSessionCreate`). One already connected means the error is journaled at once.
 *
 * The daemon runs for days, so both maps are told to forget: a lease that is released or reaped
 * has its buffer dropped (`onLeaseClosed`), and a session that has ended has its dedupe memory
 * dropped (`onSessionEnd`). Without those, every failed lease and every ended session leaves an
 * entry behind forever.
 *
 * Deduplication: when the SDK IS installed it reports the same throw as `error.uncaught` — with
 * the browser's `Uncaught ` prefix on the message, which Playwright's spelling lacks. Both
 * spellings fold into one identity (`uncaughtIdentity`), and whichever source is seen first
 * suppresses the other's copy. A journal write is deferred by a short window first, so an SDK
 * event racing the page error lands inside the window and wins. The reverse race — our copy
 * first, the SDK's right after — can still journal both; the SDK's own event is authoritative and
 * only the redundant second copy is cost, not wrong evidence.
 */
import { CONSOLE_EVENT, EventType, RETICLE_URL_PARAM, type ReticleEvent } from '@reticlehq/core';
import type { PooledDialog, PooledPageError } from './pool-contract.js';

/**
 * What a dismissal answers, per dialog kind the wire knows. The same replies the SDK gives
 * (`observers/dialogs.ts`): `confirm` is "no", `prompt` is no value, `alert` has no answer.
 * A kind not in this map (`beforeunload`) is not a `dialog.opened` and is not reported.
 */
const DISMISSED_ANSWER: Readonly<Record<string, { answered?: boolean | null }>> = {
  alert: {},
  confirm: { answered: false },
  prompt: { answered: null },
};

/** How many errors wait per lease for a session that may never connect. Older ones give way. */
const MAX_BUFFERED_PER_LEASE = 8;
/** How many recent error identities a session tracks — the dedupe memory for both sources. */
const MAX_TRACKED_IDENTITIES = 32;
/**
 * How long a journal write waits before committing, so an SDK event for the same throw — the
 * websocket hop against a CDP callback — can arrive first and claim the identity.
 */
const DEDUPE_WAIT_MS = 50;

/** The session surface the journal needs. The real `Session` satisfies this structurally. */
export interface JournalableSession {
  readonly id: string;
  readonly url?: string;
  pushEvent(event: ReticleEvent): void;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
}

export interface PageErrorJournal {
  /** The pool's sink — hand it to `BrowserPoolOptions.onPageError`. */
  onPoolPageError(leaseId: string, error: PooledPageError): void;
  /** The bridge hook — register with `bridge.attachSessionCreate`. */
  onSessionCreate(session: JournalableSession): void;
  /** The pool's release hook — register with `BrowserPoolOptions.onLeaseClosed`. */
  onLeaseClosed(leaseId: string): void;
  /** The bridge hook — register with `bridge.attachSessionEnd`. */
  onSessionEnd(sessionId: string): void;
  /**
   * The pool's dialog sink — hand it to `BrowserPoolOptions.onDialog`. Journals the dismissal as
   * `dialog.opened` on the lease's session, so a verdict reads it as the SDK's own answer. A dialog
   * before the session connects is dropped: no action window can hold it.
   */
  onPoolDialog(leaseId: string, dialog: Pick<PooledDialog, 'kind' | 'message'>): void;
}

/**
 * Fold the two spellings of one throw into one identity. Chromium prefixes a window-reported
 * uncaught error with `Uncaught ` and often the error class (`Uncaught TypeError: ...`); the
 * Playwright `pageerror` message is the bare exception text. Everything after the first line is a
 * stack fragment and never matches, so it is dropped.
 */
export function uncaughtIdentity(rawMessage: string): string {
  const withoutPrefix = rawMessage.replace(/^Uncaught\s+/i, '');
  const firstLine = withoutPrefix.split('\n')[0] ?? withoutPrefix;
  // Lazy `*?`: the greedy spelling cannot match a BARE `Error: ` — the leading character class
  // eats the `E` and backtracking never gives it back.
  return firstLine.replace(/^[A-Za-z0-9_]*?(?:Error|Exception):\s*/, '');
}

/** The first stack frame's file and line — the `source (file:line)` the issue asks the agent to see. */
const STACK_FRAME = /\bat\s+(\S+?):(\d+):\d+\b/;

function originOf(stack: string | undefined): { source?: string; line?: number } {
  if (stack === undefined) {
    return {};
  }
  const frame = STACK_FRAME.exec(stack);
  const source = frame?.[1];
  const line = frame?.[2];
  if (source === undefined || line === undefined) {
    return {};
  }
  return { source, line: Number(line) };
}

function leaseParamOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).searchParams.get(RETICLE_URL_PARAM.SESSION) ?? undefined;
  } catch {
    return undefined;
  }
}

const realSleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

export function makePageErrorJournal(deps: {
  resolveSession: (leaseId: string) => JournalableSession | undefined;
  sleep?: (ms: number) => Promise<void>;
}): PageErrorJournal {
  const sleep = deps.sleep ?? realSleep;
  /** Errors heard before their session connected, keyed by lease id. */
  const buffered = new Map<string, { errors: PooledPageError[]; dropped: number }>();
  /** Per session: identities already claimed by the SDK or by us, oldest first. */
  const seen = new Map<string, string[]>();

  const mark = (sessionId: string, identity: string): void => {
    const identities = seen.get(sessionId) ?? [];
    if (identities.includes(identity)) {
      return;
    }
    identities.push(identity);
    if (identities.length > MAX_TRACKED_IDENTITIES) {
      identities.shift();
    }
    seen.set(sessionId, identities);
  };

  const seenBefore = (sessionId: string, identity: string): boolean => {
    return (seen.get(sessionId) ?? []).includes(identity);
  };

  const journal = async (
    session: JournalableSession,
    error: PooledPageError,
    droppedCount?: number,
  ): Promise<void> => {
    await sleep(DEDUPE_WAIT_MS);
    const identity = uncaughtIdentity(error.message);
    if (seenBefore(session.id, identity)) {
      return;
    }
    mark(session.id, identity);
    const { source, line } = originOf(error.stack);
    session.pushEvent({
      t: 0, // pushEvent re-stamps with the session's own clock
      type: EventType.CONSOLE_ERROR,
      sessionId: session.id,
      data: {
        message: error.message,
        kind: CONSOLE_EVENT.PAGE_ERROR,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
        ...(source === undefined ? {} : { source }),
        ...(line === undefined ? {} : { line }),
        ...(droppedCount === undefined
          ? {}
          : { [CONSOLE_EVENT.DROPPED_PAGE_ERRORS]: droppedCount }),
      },
    });
  };

  // A page error must never break the connect path or the session that receives it.
  const journalSafely = (
    session: JournalableSession,
    error: PooledPageError,
    droppedCount?: number,
  ): void => {
    journal(session, error, droppedCount).catch(() => undefined);
  };

  return {
    onPoolPageError(leaseId, error) {
      const session = deps.resolveSession(leaseId);
      if (session !== undefined) {
        journalSafely(session, error);
        return;
      }
      const entry = buffered.get(leaseId) ?? { errors: [], dropped: 0 };
      if (entry.errors.length >= MAX_BUFFERED_PER_LEASE) {
        entry.errors.shift();
        entry.dropped += 1;
      }
      entry.errors.push(error);
      buffered.set(leaseId, entry);
    },

    onSessionCreate(session) {
      // Claim identities the SDK reports, so a page error the SDK already journaled adds no copy.
      session.onEvent((event) => {
        if (event.type !== EventType.ERROR_UNCAUGHT) {
          return;
        }
        const message = event.data['message'];
        if ('string' !== typeof message) {
          return;
        }
        mark(session.id, uncaughtIdentity(message));
      });

      const leaseId = leaseParamOf(session.url);
      if (leaseId === undefined) {
        return;
      }
      const entry = buffered.get(leaseId);
      if (entry === undefined) {
        return;
      }
      buffered.delete(leaseId);
      // The buffer is bounded, so a page that threw harder than the bound reports the loss on the
      // first error that survived — the count names what the agent is not seeing.
      entry.errors.forEach((error, i) => {
        journalSafely(session, error, 0 === i && entry.dropped > 0 ? entry.dropped : undefined);
      });
    },

    // A lease that is released or reaped will never flush: its session already ended, or its page
    // died before any SDK connected. The buffer has nowhere to go, so it goes away.
    onLeaseClosed(leaseId) {
      buffered.delete(leaseId);
    },

    // The dedupe memory belongs to one session's lifetime; an ended session's identities would
    // otherwise suppress nothing real and grow for the life of the daemon.
    onSessionEnd(sessionId) {
      seen.delete(sessionId);
    },

    onPoolDialog(leaseId, dialog) {
      // An own key only: an inherited name such as `toString` is not a dialog kind.
      const kind = dialog.kind;
      const answer =
        kind !== undefined && Object.hasOwn(DISMISSED_ANSWER, kind)
          ? DISMISSED_ANSWER[kind]
          : undefined;
      const session = deps.resolveSession(leaseId);
      if (answer === undefined || session === undefined) {
        return;
      }
      session.pushEvent({
        t: 0, // pushEvent re-stamps with the session's own clock
        type: EventType.DIALOG_OPENED,
        sessionId: session.id,
        data: { kind: dialog.kind, message: dialog.message, ...answer },
      });
    },
  };
}
