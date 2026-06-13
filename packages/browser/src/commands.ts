import {
  ActionType,
  ComponentStateReason,
  ElementQuerySchema,
  IrisCommand,
  SnapshotMode,
  type ComponentStateResult,
  type ElementQuery,
  type ElementState,
} from '@syrin/iris-protocol';
import { buildSnapshot } from './snapshot.js';
import { matchQuery, runQuery } from './query.js';
import { executeAction, executeSequence, dispatchWebMcp, type ActionStep } from './actions.js';
import { describe } from './a11y.js';
import { refs } from './refs.js';
import { identifyComponent, readComponentState } from './adapters.js';
import { readStores, storeNames } from './stores.js';
import { getCapabilities } from './capabilities.js';
import { freezeClock, advanceClock, resetClock, isClockFrozen } from './clock.js';
import { scrollContainer } from './scroll.js';

export type CommandHandler = (args: Record<string, unknown>) => unknown;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function queryFromArgs(args: Record<string, unknown>): ElementQuery {
  return {
    by: str(args['by']) as ElementQuery['by'],
    value: str(args['value']),
    role: str(args['role']),
    name: str(args['name']),
    text: str(args['text']),
    label: str(args['label']),
    placeholder: str(args['placeholder']),
    testid: str(args['testid']),
    alt: str(args['alt']),
    scope: str(args['scope']),
  };
}

function inspect(ref: string): unknown {
  const el = refs.resolve(ref);
  if (el === null) return { error: `ref '${ref}' no longer resolves` };
  const rect = el.getBoundingClientRect();
  const component = identifyComponent(el);
  const view = el.ownerDocument.defaultView;
  const cs = view !== null ? view.getComputedStyle(el) : null;
  const styles =
    cs !== null
      ? { color: cs.color, backgroundColor: cs.backgroundColor, opacity: cs.opacity }
      : null;
  return {
    ...describe(el),
    tag: el.tagName.toLowerCase(),
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    styles,
    component,
  };
}

/** Narrowing guard: an adapter returned a F5 ComponentStateResult (has a boolean `ok`). */
function isComponentStateResult(value: unknown): value is ComponentStateResult {
  return (
    typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean'
  );
}

const COMPONENT_UNAVAILABLE: ComponentStateResult = {
  ok: false,
  reason: ComponentStateReason.UNAVAILABLE,
};

/**
 * Stores are the reliable path. The `ref` component read is bounded (F5): a stale ref, no
 * adapter, or an adapter returning a non-conforming value all collapse to a structured
 * `{ ok: false, reason }` — never a raw (possibly circular) object that could hang serialization.
 */
function readState(ref: string | undefined, store: string | undefined): unknown {
  const stores = readStores(store);
  const result: {
    stores: Record<string, unknown>;
    storeNames: string[];
    component?: ComponentStateResult;
  } = {
    stores,
    storeNames: storeNames(),
  };
  if (ref !== undefined && ref.length > 0) {
    const el = refs.resolve(ref);
    if (el === null) {
      result.component = COMPONENT_UNAVAILABLE;
    } else {
      const state = readComponentState(el);
      result.component = isComponentStateResult(state) ? state : COMPONENT_UNAVAILABLE;
    }
  }
  return result;
}

function listAnimations(): unknown {
  const doc = document as Document & { getAnimations?: () => Animation[] };
  if (typeof doc.getAnimations !== 'function') return { animations: [] };
  const animations = doc.getAnimations().map((a) => {
    const effect = a.effect;
    const timing = effect?.getTiming();
    return {
      playState: a.playState,
      currentTime: a.currentTime,
      duration: timing?.duration,
    };
  });
  return { animations };
}

/** Map browser command names to handlers. Used by the transport on each COMMAND. */
export function createCommandRegistry(): Map<string, CommandHandler> {
  const reg = new Map<string, CommandHandler>();
  reg.set(IrisCommand.SNAPSHOT, (args) =>
    buildSnapshot({
      scope: str(args['scope']),
      mode: (str(args['mode']) as SnapshotMode | undefined) ?? SnapshotMode.FULL,
    }),
  );
  reg.set(IrisCommand.QUERY, (args) => runQuery(queryFromArgs(args)));
  reg.set(IrisCommand.MATCH, (args) =>
    matchQuery(
      ElementQuerySchema.parse(record(args['query'])),
      str(args['state']) as ElementState | undefined,
    ),
  );
  reg.set(IrisCommand.ACT, (args) => {
    const action = str(args['action']) ?? '';
    if (action === ActionType.WEBMCP) {
      const inner = record(args['args']);
      return dispatchWebMcp(str(inner['tool']) ?? '', record(inner['params']));
    }
    return executeAction(str(args['ref']) ?? '', action, record(args['args']));
  });
  reg.set(IrisCommand.ACT_SEQUENCE, (args) =>
    executeSequence((Array.isArray(args['steps']) ? args['steps'] : []) as ActionStep[]),
  );
  reg.set(IrisCommand.INSPECT, (args) => inspect(str(args['ref']) ?? ''));
  reg.set(IrisCommand.ANIMATIONS, () => listAnimations());
  reg.set(IrisCommand.CLOCK, (args) => {
    if (args['reset'] === true) {
      resetClock();
    } else {
      if (args['freeze'] === true) freezeClock();
      const adv = args['advanceMs'];
      if (typeof adv === 'number') advanceClock(adv);
    }
    return { frozen: isClockFrozen() };
  });
  reg.set(IrisCommand.STATE_READ, (args) => readState(str(args['ref']), str(args['store'])));
  reg.set(IrisCommand.CAPABILITIES, () => getCapabilities());
  reg.set(IrisCommand.SCROLL, (args) => {
    const dy = args['dy'];
    return scrollContainer(str(args['ref']), typeof dy === 'number' ? dy : undefined);
  });
  return reg;
}
