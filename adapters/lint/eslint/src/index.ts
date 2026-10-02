/** @reticlehq/eslint-plugin — flat-config plugin export. */

import { requireSignalOnMutation } from './require-signal-on-mutation.js';
import { noInternalTags } from './no-internal-tags.js';
import { noRunawayComment } from './no-runaway-comment.js';
import {
  PLUGIN_NAME,
  RULE_NAME,
  INTERNAL_TAGS_RULE_NAME,
  RUNAWAY_COMMENT_RULE_NAME,
} from './constants.js';

export const rules = {
  [RULE_NAME]: requireSignalOnMutation,
  [INTERNAL_TAGS_RULE_NAME]: noInternalTags,
  [RUNAWAY_COMMENT_RULE_NAME]: noRunawayComment,
} as const;

const plugin = {
  meta: { name: PLUGIN_NAME },
  rules,
  configs: {} as Record<string, unknown>,
};

// recommended flat config: turns the rule on with empty (no-op) defaults.
// Bracket access because `configs` is an index signature: under
// `noPropertyAccessFromIndexSignature` a dotted read of a key the type does not declare is exactly
// the typo class that flag exists to catch, and this file is the one place in the monorepo that did it.
plugin.configs['recommended'] = {
  plugins: { [PLUGIN_NAME]: plugin },
  rules: {
    [`${PLUGIN_NAME}/${RULE_NAME}`]: 'warn',
    [`${PLUGIN_NAME}/${INTERNAL_TAGS_RULE_NAME}`]: 'error',
    [`${PLUGIN_NAME}/${RUNAWAY_COMMENT_RULE_NAME}`]: 'error',
  },
};

export default plugin;
export { requireSignalOnMutation, noInternalTags, noRunawayComment };
