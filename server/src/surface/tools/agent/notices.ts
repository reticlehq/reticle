/**
 * One `notices` field, each notice at most once per agent session.
 *
 * Advisories used to arrive as their own keys — `feedback_prompt`, `talk_to_us`, `platform`,
 * `update_available`, `session_lease`… — each with its own paragraph, and the ones that were not
 * one-shot at the source repeated on every call. An agent reads a result to find the verdict; every
 * advisory beside it is something it has to read past, and the same one twice is pure cost.
 *
 * So, for an agent's own call: each advisory becomes ONE line in `notices`, said once per agent
 * session (one MCP connection); `next` is said only when it says something new; the throttled-tab
 * paragraph is said once (the `session.throttled` flag still rides on every result — the FACT is
 * never deduplicated, only its explanation). Telemetry already counted every advisory when it was
 * taken, before this runs.
 *
 * `detail: "full"` callers and the Harness/HUD get the result untouched.
 */

/** Which result keys fold into notices, and where the folded lines go. Supplied by the dispatcher. */
export interface NoticeFold {
  /** Advisory keys whose value becomes one notice line. */
  readonly advisories: readonly string[];
  /** Where the lines go. */
  readonly notices: string;
  /** The one-line "do this next" key: kept only when its text is new this session. */
  readonly next: string;
  /** The key the session-health warning travels under. */
  readonly warning: string;
  /**
   * Warnings that are paragraphs about the TAB (throttled, version skew): said in full once per
   * session, then replaced by their short form (`undefined` drops it — used only where the fact
   * itself still rides on every result, as `session.throttled` does).
   */
  readonly onceWarnings: ReadonlyMap<string, string | undefined>;
}

/**
 * The one-line pointer an agent session's first answer carries. The primer itself lives in the
 * agent's rules file (written by `reticle init`), which survives a compaction; a tool result does not.
 */
export const PRIMER_POINTER =
  'Reticle\'s rules are in the Reticle section of your CLAUDE.md / AGENTS.md. Context compacted? reticle_run { tool: "reticle_context", args: { compact: true } } first.';

/** An empty session list keeps its first sentence; the executable `next_action` carries the rest. */
const WHY_KEY = 'why';
const SESSIONS_KEY = 'sessions';

/** Fields of an advisory object that hold its sentence, in the order they are tried. */
const SENTENCE_FIELDS: readonly string[] = [
  'ask',
  'message',
  'text',
  'line',
  'reason',
  'IMPORTANT',
];

/** Bound on remembered lines per session, and on remembered sessions: a daemon outlives both. */
const MAX_LINES = 200;
const MAX_SESSIONS = 500;

const seenBySession = new Map<string, Set<string>>();

/** Tests only. */
export function resetNotices(): void {
  seenBySession.clear();
  feedbackAsked.clear();
}

function seenFor(session: string): Set<string> {
  let seen = seenBySession.get(session);
  if (seen === undefined) {
    if (seenBySession.size >= MAX_SESSIONS) {
      const oldest = seenBySession.keys().next().value;
      if (oldest !== undefined) seenBySession.delete(oldest);
    }
    seen = new Set();
    seenBySession.set(session, seen);
  }
  return seen;
}

/** First time this session sees `line`? Records it either way. */
function firstTime(seen: Set<string>, line: string): boolean {
  if (seen.has(line)) return false;
  if (seen.size < MAX_LINES) seen.add(line);
  return true;
}

/** One line from an advisory's value: a string as-is, an object by its sentence field. */
export function noticeLine(value: unknown): string | undefined {
  if ('string' === typeof value) return 0 === value.trim().length ? undefined : value.trim();
  if ('object' !== typeof value || null === value) return undefined;
  const record = value as Record<string, unknown>;
  for (const field of SENTENCE_FIELDS) {
    const text = record[field];
    if ('string' === typeof text && text.trim().length > 0) {
      const command = record['command'];
      return 'string' === typeof command ? `${text.trim()} (${command})` : text.trim();
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** The first sentence of a paragraph (a full stop followed by a space or the end). */
export function firstSentenceOf(text: string): string {
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text);
  return (match?.[0] ?? text).trim();
}

/** Fold a result's advisories into once-per-session notices. Never touches any other key. */
export function foldNotices(
  result: Record<string, unknown>,
  session: string,
  fold: NoticeFold,
  extra: readonly string[] = [],
): Record<string, unknown> {
  const seen = seenFor(session);
  const out: Record<string, unknown> = { ...result };
  const lines: string[] = Array.isArray(out[fold.notices])
    ? (out[fold.notices] as unknown[]).filter((l): l is string => 'string' === typeof l)
    : [];
  for (const key of fold.advisories) {
    if (!(key in out)) continue;
    const line = noticeLine(out[key]);
    delete out[key];
    if (line !== undefined && firstTime(seen, `${key}\u0000${line}`)) lines.push(line);
  }
  for (const line of extra) if (firstTime(seen, `\u0000${line}`)) lines.push(line);
  const next = out[fold.next];
  if ('string' === typeof next && !firstTime(seen, `${fold.next}\u0000${next}`)) {
    delete out[fold.next];
  }
  const warning = out[fold.warning];
  if (
    'string' === typeof warning &&
    fold.onceWarnings.has(warning) &&
    !firstTime(seen, `${fold.warning}\u0000${warning}`)
  ) {
    const short = fold.onceWarnings.get(warning);
    if (short === undefined) delete out[fold.warning];
    else out[fold.warning] = short;
  }
  const sessions = out[SESSIONS_KEY];
  const why = out[WHY_KEY];
  if (Array.isArray(sessions) && 0 === sessions.length && 'string' === typeof why) {
    out[WHY_KEY] = firstSentenceOf(why);
  }
  if (lines.length > 0) out[fold.notices] = lines;
  else delete out[fold.notices];
  return out;
}

/**
 * The feedback reflex, at most once per agent session.
 *
 * The ask (`feedback_prompt`), the friction invitation (`feedback_invite` + `talk_to_us`) and their
 * kin are one family: an agent asked twice in a session hears noise. Gated where they are TAKEN
 * rather than hidden after, so the `feedbackPrompted` denominator counts only asks an agent saw.
 */
const feedbackAsked = new Set<string>();

/** Has this agent session already been asked for feedback? Undefined session: never gated. */
export function feedbackAlreadyAsked(session: string | undefined): boolean {
  return session !== undefined && feedbackAsked.has(session);
}

/** Record that this session was asked. */
export function noteFeedbackAsked(session: string | undefined): void {
  if (session === undefined) return;
  if (feedbackAsked.size >= MAX_SESSIONS) feedbackAsked.clear();
  feedbackAsked.add(session);
}
