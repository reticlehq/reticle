/**
 * The prompt side of a verification: what the user asked for, relayed by the agent, and every
 * statement in it and in the agent's declared intents, classified and attributed. Daemon-side only:
 * a run carries it loosely (`context`), so it adds nothing to what a page downloads.
 */
import { z } from 'zod';

/** What a statement in the prompt context is, so a reader can tell a goal from a preference. */
export const StatementKind = {
  /** What the product should do for its users: the reason the work exists. */
  BUSINESS_INTENT: 'business-intent',
  /** What to change in the code: implement, fix, refactor, rename, test. */
  CODING_INTENT: 'coding-intent',
  /** How it must look or feel: layout, spacing, mobile, accessibility. */
  UX_EXPECTATION: 'ux-expectation',
  /** Who may see or do what, and what must never leak. */
  SECURITY: 'security-requirement',
  ACCEPTANCE: 'acceptance-criterion',
  CONSTRAINT: 'technical-constraint',
  PREFERENCE: 'preference',
  /** What not to touch, or not now. */
  OUT_OF_SCOPE: 'out-of-scope',
} as const;
export type StatementKind = (typeof StatementKind)[keyof typeof StatementKind];

/** Who said it. The user's words reach Reticle through the agent, so `user` means relayed verbatim. */
export const StatementSource = {
  USER: 'user',
  AGENT: 'agent',
} as const;
export type StatementSource = (typeof StatementSource)[keyof typeof StatementSource];

/** The words that make a statement each kind. Checked in this order; the first that matches wins. */
const STATEMENT_RULES: readonly { kind: StatementKind; words: RegExp }[] = [
  {
    kind: StatementKind.OUT_OF_SCOPE,
    words:
      /\b(don't (?:touch|change|modify)|do not (?:touch|change|modify)|leave (?:it|that|the \w+) (?:alone|as is)|out of scope|not (?:now|yet|in this)|no need to)\b/i,
  },
  {
    kind: StatementKind.PREFERENCE,
    words: /\b(i (?:prefer|like|want it|would rather)|ideally|nicer|taste|style)\b/i,
  },
  {
    kind: StatementKind.SECURITY,
    words:
      /\b(secure|security|unauthori[sz]ed|authori[sz]ation|permissions?|admins? only|only admins?|roles?|leaks?|xss|csrf|password|secrets?|pii)\b/i,
  },
  {
    kind: StatementKind.CODING_INTENT,
    words:
      /\b(refactor|implement|rename|migrate|extract|clean up|write (?:a |the )?tests?|add (?:a |an )?(?:test|function|component|hook|endpoint|route|migration)|fix (?:the |this |a )?(?:bug|error|crash|issue|test)|debug)\b/i,
  },
  {
    kind: StatementKind.UX_EXPECTATION,
    words:
      /\b(layout|spacing|align(?:ed|ment)?|responsive|mobile|dark mode|colou?rs?|font|animation|accessib\w*|a11y|keyboard|screen reader|looks?|feels?)\b/i,
  },
  {
    kind: StatementKind.CONSTRAINT,
    words:
      /\b(use|don't use|do not use|without|library|framework|api|endpoint|database|schema|typescript|react|must not import|performance|latency)\b/i,
  },
  {
    kind: StatementKind.ACCEPTANCE,
    words:
      /\b(must|should|has to|needs to|shows?|displays?|returns?|when .* then|so that|until)\b/i,
  },
];

/**
 * A statement's kind, by the words in it.
 *
 * ponytail: keyword rules, not a model. Good enough to separate "the checkout must show the total"
 * from "use the existing Button" from "I prefer it darker"; a model classifier can replace this
 * function without changing what is stored.
 */
export function classifyStatement(text: string): StatementKind {
  for (const rule of STATEMENT_RULES) if (rule.words.test(text)) return rule.kind;
  return StatementKind.BUSINESS_INTENT;
}

/** A request split into the sentences a reader would weigh one at a time. */
export function splitStatements(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => 0 < s.length);
}

/**
 * The prompt side of a verification: what the user asked for (relayed by the agent), and each
 * statement in it and in the agent's declared intents, classified and attributed.
 *
 * `shared` decides whether it leaves this machine. A linked project shares it by default, so the
 * platform can read what each run was for; `"shareRequests": false` in .reticle.json keeps it here,
 * and an unlinked project has nowhere to send it. See `shareableRun`.
 */
export const PromptContextSchema = z.object({
  /** The whole prompt, redacted. Long prompts are the useful ones, so the cap is generous. */
  request: z.string().max(20_000).optional(),
  statements: z
    .array(
      z.object({
        text: z.string().max(500),
        kind: z.nativeEnum(StatementKind),
        source: z.nativeEnum(StatementSource),
      }),
    )
    .max(100)
    .default([]),
  /** When the request was given, epoch ms. A run long after it is not about it. */
  at: z.number().optional(),
  shared: z.boolean().optional(),
});
export type PromptContext = z.infer<typeof PromptContextSchema>;

/** A run as it may leave this machine: its prompt context only when the project shares it. */
export function shareableRun(run: unknown): unknown {
  if ('object' !== typeof run || null === run || !('context' in run)) return run;
  const { context, ...rest } = run as { context?: { shared?: unknown } };
  return true === context?.shared ? run : rest;
}
