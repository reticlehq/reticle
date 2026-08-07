/**
 * The `reticle feedback` grammar — flags, kind validation, and the message-vs-flag split.
 *
 * Split out of `cli-parse.ts` when that file crossed the line cap. Cohesive on its own terms: this
 * is the one command whose arguments are free text, so it is the only place in the grammar where
 * "everything that is not a flag" is a rule with edge cases rather than a one-liner.
 */
import { FeedbackKind } from '@reticlehq/core';

/** `reticle feedback --rating 4 "the words"` — the human half of the channel. */
export const RATING_FLAG = '--rating';
export const BUG_FLAG = '--bug';
/**
 * The AGENT half of the same channel, for the phase where `reticle_feedback` does not exist yet.
 *
 * An agent that is still installing Reticle — or that just watched `init` fail, or a daemon refuse to
 * start — has no MCP tools to file with, and that is exactly the report we most need: the failures
 * that happen before the tool surface is reachable are invisible to every other path we have. This
 * gives that agent the same shape the tool takes, over a command that needs nothing running.
 */
export const KIND_FLAG = '--kind';
export const AGENT_FLAG = '--agent';
/** Accepted `--kind` values, from core's enum — never a second hand-written list to drift from it. */
export const FEEDBACK_KINDS: readonly string[] = Object.values(FeedbackKind);

/** What `parseFeedbackArgs` yields: the parsed command, or a usage error to print. */
export type ParsedFeedback =
  | {
      kind: 'feedback';
      text: string;
      rating?: number;
      /** The FeedbackKind name from `--kind`; absent means the legacy bug/experience split. */
      feedbackKind?: string;
      bug: boolean;
      /** `--agent`: file as the agent, so agent reports never dilute the human rating signal. */
      agent: boolean;
    }
  | { kind: 'error'; message: string };

/** Parse everything after `reticle feedback`. */
export function parseFeedbackArgs(rest: string[]): ParsedFeedback {
  const ratingAt = rest.indexOf(RATING_FLAG);
  const rating = ratingAt === -1 ? undefined : Number(rest[ratingAt + 1]);
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return { kind: 'error', message: `${RATING_FLAG} takes a whole number from 1 to 5` };
  }
  const kindAt = rest.indexOf(KIND_FLAG);
  const feedbackKind = kindAt === -1 ? undefined : rest[kindAt + 1];
  if (feedbackKind !== undefined && !FEEDBACK_KINDS.includes(feedbackKind)) {
    return { kind: 'error', message: `${KIND_FLAG} takes one of: ${FEEDBACK_KINDS.join(', ')}` };
  }
  // Everything that is not a flag or a flag's VALUE is the message. Quoting is the user's job for
  // shell reasons, but joining the remainder means an unquoted sentence still works. Both value
  // positions have to be consumed: without that, `--kind bug "..."` filed a report whose text began
  // with the word "bug".
  const consumed = new Set([
    ...(ratingAt === -1 ? [] : [ratingAt, ratingAt + 1]),
    ...(kindAt === -1 ? [] : [kindAt, kindAt + 1]),
  ]);
  const text = rest
    .filter((arg, i) => !consumed.has(i) && !arg.startsWith('--'))
    .join(' ')
    .trim();
  return {
    kind: 'feedback',
    text,
    ...(rating !== undefined ? { rating } : {}),
    ...(feedbackKind !== undefined ? { feedbackKind } : {}),
    bug: rest.includes(BUG_FLAG),
    agent: rest.includes(AGENT_FLAG),
  };
}
