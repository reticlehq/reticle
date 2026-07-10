import { ReticleCommand, PresenterMode } from '@reticlehq/core';
import { refs } from './dom/refs.js';
import { describe } from './dom/a11y.js';

/** Coerce an unknown arg to a string, falling back to `fallback` (default empty) when it isn't one. */
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** A short human label for a ref ("button \"Save\"") for the presenter HUD. */
export function refLabel(refId: string): string {
  const el = refs.resolve(refId);
  if (!(el instanceof Element)) return refId;
  const d = describe(el);
  return d.name.length > 0 ? `${d.role} "${d.name}"` : `${d.role} (${refId})`;
}

/**
 * Classify a browser command into the presenter intent the human watcher sees. Exhaustive
 * over the ReticleCommand names that actually reach the browser. CLOCK/NARRATE are control/meta
 * (neither a page read nor an act) -> IDLE so they don't paint a misleading chip. NARRATE never
 * reaches #presentBefore anyway (it returns early in #handleCommand) and must not clear the mode.
 */
export function modeForCommand(commandName: string): PresenterMode {
  switch (commandName) {
    case ReticleCommand.ACT:
    case ReticleCommand.ACT_SEQUENCE:
      return PresenterMode.ACTING;
    case ReticleCommand.SNAPSHOT:
    case ReticleCommand.QUERY:
    case ReticleCommand.MATCH:
    case ReticleCommand.INSPECT:
    case ReticleCommand.ANIMATIONS:
    case ReticleCommand.STATE_READ:
    case ReticleCommand.CAPABILITIES:
      return PresenterMode.READING;
    default:
      return PresenterMode.IDLE;
  }
}

/**
 * Human-legible status for a read command — now WITH the target (which testid/value/ref/store), so
 * the watcher sees "Finding [testid=row-3700]" instead of a meaningless repeating "Finding an
 * element". Falls back to the bare verb when no target is in the args.
 */
export function presentStatus(commandName: string, args: Record<string, unknown> = {}): string {
  switch (commandName) {
    case ReticleCommand.SNAPSHOT:
      return 'Looking at the page';
    case ReticleCommand.QUERY:
    case ReticleCommand.MATCH: {
      const q = commandName === ReticleCommand.MATCH ? (args['query'] ?? {}) : args;
      const target = queryTarget(q as Record<string, unknown>);
      return target !== undefined ? `Finding ${target}` : 'Finding an element';
    }
    case ReticleCommand.INSPECT: {
      const ref = str(args['ref']);
      return ref !== undefined ? `Inspecting ${refLabel(ref)}` : 'Inspecting an element';
    }
    case ReticleCommand.ANIMATIONS:
      return 'Reading animations';
    case ReticleCommand.STATE_READ: {
      const store = str(args['store']);
      return store !== undefined ? `Reading state: ${store}` : 'Reading state';
    }
    case ReticleCommand.CAPABILITIES:
      return 'Reading capabilities';
    default:
      return commandName;
  }
}

/** Compact "what we're looking for" from a query's args (testid/value/name/role/text/label). */
function queryTarget(q: Record<string, unknown>): string | undefined {
  const testid = str(q['testid']) ?? (str(q['by']) === 'testid' ? str(q['value']) : undefined);
  if (testid !== undefined) return `[testid=${testid}]`;
  const name = str(q['name']);
  const value = str(q['value']) ?? str(q['text']) ?? str(q['label']) ?? str(q['role']);
  if (value !== undefined) return name !== undefined ? `"${value}" (${name})` : `"${value}"`;
  return name !== undefined ? `"${name}"` : undefined;
}
