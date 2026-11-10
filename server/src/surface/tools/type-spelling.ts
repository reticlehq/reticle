/**
 * The `fill` spelling mapped onto the `type` action.
 *
 * The tool documents `{ text }` for type and `{ value }` for fill/select, and agents mix them up
 * constantly — `reticle_act` with `{ action: "type", value: "…" }` then fails at run time with
 * "type requires a string `text`", after the action window opened (reticlehq/reticle#2126, second
 * item). When `text` is absent and `value` is a string, `value` becomes `text`, in the flat args
 * and in the nested `args` object. A non-string `value` is left alone so the browser's own
 * refusal keeps its accurate message.
 *
 * Shared by the dispatch point (act-command.ts) and the tests.
 */

import { ActionType } from '@reticlehq/core';

export function normalizeTypeSpelling(actArgs: Record<string, unknown>): Record<string, unknown> {
  if (ActionType.TYPE !== actArgs['action']) {
    return actArgs;
  }
  const out = { ...actArgs };
  const mapValueToText = (record: Record<string, unknown>): boolean => {
    if (record['text'] !== undefined || 'string' !== typeof record['value']) {
      return false;
    }
    record['text'] = record['value'];
    delete record['value'];
    return true;
  };
  mapValueToText(out);
  const nested = out['args'];
  if (null !== nested && 'object' === typeof nested && !Array.isArray(nested)) {
    const nestedCopy = { ...(nested as Record<string, unknown>) };
    if (mapValueToText(nestedCopy)) {
      out['args'] = nestedCopy;
    }
  }
  return out;
}
