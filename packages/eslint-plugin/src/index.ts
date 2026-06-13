/** @syrin/iris-eslint-plugin — flat-config plugin export. */

import { requireSignalOnMutation } from './require-signal-on-mutation.js';
import { PLUGIN_NAME, RULE_NAME } from './constants.js';

export const rules = { [RULE_NAME]: requireSignalOnMutation } as const;

const plugin = {
  meta: { name: PLUGIN_NAME },
  rules,
  configs: {} as Record<string, unknown>,
};

// recommended flat config: turns the rule on with empty (no-op) defaults.
plugin.configs.recommended = {
  plugins: { [PLUGIN_NAME]: plugin },
  rules: { [`${PLUGIN_NAME}/${RULE_NAME}`]: 'warn' },
};

export default plugin;
export { requireSignalOnMutation };
