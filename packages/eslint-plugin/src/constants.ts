/** Constants for the Iris ESLint plugin (no free strings). */

/** The single rule id this plugin ships. */
export const RULE_NAME = 'require-signal-on-mutation';

/** messageId keys (reported via context.report). */
export const MessageId = {
  MUTATION_WITHOUT_SIGNAL: 'mutationWithoutSignal',
} as const;
export type MessageId = (typeof MessageId)[keyof typeof MessageId];

/** The human-readable report text (the assertion in tests matches this verbatim). */
export const MUTATION_WITHOUT_SIGNAL_MESSAGE = 'store mutation without a mapped Iris signal';

/** Default signal-callee names recognized when the consumer passes none. */
export const DEFAULT_SIGNAL_CALLEES = ['irisSignal', 'signal'] as const;

/** Default mutators = NONE. With no configured mutators the rule never fires (safe no-op). */
export const DEFAULT_MUTATORS: readonly string[] = [];

/** Plugin meta name used in the flat-config export + RuleCreator url namespace. */
export const PLUGIN_NAME = 'iris';

/** Docs URL builder root for ESLintUtils.RuleCreator. */
export const DOCS_URL_ROOT =
  'https://github.com/syrin-labs/iris/blob/main/packages/eslint-plugin/README.md';
