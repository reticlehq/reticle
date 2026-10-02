/** Constants for the Reticle ESLint plugin (no free strings). */

/** The single rule id this plugin ships. */
export const RULE_NAME = 'require-signal-on-mutation';

/** messageId keys (reported via context.report). */
export const MessageId = {
  MUTATION_WITHOUT_SIGNAL: 'mutationWithoutSignal',
} as const;
export type MessageId = (typeof MessageId)[keyof typeof MessageId];

/** The human-readable report text (the assertion in tests matches this verbatim). */
export const MUTATION_WITHOUT_SIGNAL_MESSAGE = 'store mutation without a mapped Reticle signal';

/** Default signal-callee names recognized when the consumer passes none. */
export const DEFAULT_SIGNAL_CALLEES = ['reticleSignal', 'signal'] as const;

/** Default mutators = NONE. With no configured mutators the rule never fires (safe no-op). */
export const DEFAULT_MUTATORS: readonly string[] = [];

/** Plugin meta name used in the flat-config export + RuleCreator url namespace. */
export const PLUGIN_NAME = 'reticle';

/** Docs URL builder root for ESLintUtils.RuleCreator. */
export const DOCS_URL_ROOT =
  'https://github.com/reticlehq/reticle/blob/main/eslint-plugin/README.md';

/** Rule that keeps design-doc codes and internal version strings out of source comments. */
export const INTERNAL_TAGS_RULE_NAME = 'no-internal-tags';

/** Rule that caps how long one block comment may be. */
export const RUNAWAY_COMMENT_RULE_NAME = 'no-runaway-comment';

/**
 * Longest permitted block comment, in lines.
 *
 * Set above the longest genuine comment in the repository (45) and far below the 423-line accident
 * this rule exists to catch, so it reports a paste and never a paragraph.
 */
export const MAX_COMMENT_LINES = 60;

/** The human-readable report text (the assertion in tests matches this verbatim). */
export const RUNAWAY_COMMENT_MESSAGE =
  'block comment is {{lines}} lines (max {{max}}) — a comment this long is usually pasted output, not prose';
