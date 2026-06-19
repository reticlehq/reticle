import {
  ActionType,
  ComponentStateReason,
  DANGEROUS_ACTION_CONFIRM_ARG,
  ElementQuerySchema,
  IrisCommand,
  SnapshotMode,
  TRANSPORT_LIMITS,
  type ComponentStateResult,
  type ElementQuery,
  type ElementState,
} from '@syrin/iris-protocol';
import { buildSnapshot } from '../dom/snapshot.js';
import { matchQuery, runQuery } from '../dom/query.js';
import {
  executeAction,
  executeSequence,
  dispatchWebMcp,
  type ActionStep,
} from '../actions/actions.js';
import { describe } from '../dom/a11y.js';
import { refs } from '../dom/refs.js';
import { identifyComponent, readComponentState } from '../registry/adapters.js';
import { readStores, storeNames } from '../registry/stores.js';
import { getCapabilities } from '../registry/capabilities.js';
import { freezeClock, advanceClock, resetClock, isClockFrozen } from '../timers/clock.js';
import { scrollContainer } from '../actions/scroll.js';

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
  // Computed style the a11y tree is blind to — `cursor` (does it look interactive?), display/
  // visibility, and color/opacity — so a UI bug that leaves the element "present but unusable"
  // (dead cursor, invisible, recolored) is observable in one inspect call.
  const styles =
    cs !== null
      ? {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          opacity: cs.opacity,
          cursor: cs.cursor,
          display: cs.display,
          visibility: cs.visibility,
        }
      : null;
  return {
    ...describe(el),
    tag: el.tagName.toLowerCase(),
    href: el.getAttribute('href') ?? undefined,
    formAction:
      el instanceof HTMLButtonElement || el instanceof HTMLInputElement
        ? (el.form?.getAttribute('action') ?? undefined)
        : undefined,
    formText:
      el instanceof HTMLButtonElement || el instanceof HTMLInputElement
        ? (el.form?.textContent ?? undefined)
        : undefined,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    // True when another element sits over this one's center point — the click would hit the overlay,
    // not this control (a z-index/overlay bug the DOM tree cannot show).
    occluded: isOccluded(el, rect),
    styles,
    component,
  };
}

/** Whether another element covers this one's center point (a transparent overlay / z-index bug). */
function isOccluded(el: Element, rect: DOMRect): boolean {
  if (rect.width === 0 || rect.height === 0) return false; // a 0×0 box is a different bug (size)
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== 'function') return false;
  const top = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return top !== null && top !== el && !el.contains(top);
}

/** Narrowing guard: an adapter returned a ComponentStateResult (has a boolean `ok`). */
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

export function resolveNavigationUrl(rawUrl: string, baseUrl: string): string | null {
  if (rawUrl.length === 0 || rawUrl.length > TRANSPORT_LIMITS.MAX_URL_LENGTH) return null;
  try {
    const url = new URL(rawUrl, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
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
      return dispatchWebMcp(
        str(inner['tool']) ?? '',
        record(inner['params']),
        inner[DANGEROUS_ACTION_CONFIRM_ARG] === true,
      );
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
    const fraction = args['fraction'];
    return scrollContainer(
      str(args['ref']),
      typeof dy === 'number' ? dy : undefined,
      typeof fraction === 'number' ? fraction : undefined,
    );
  });
  reg.set(IrisCommand.NAVIGATE, (args) => {
    const rawUrl = str(args['url']);
    if (rawUrl === undefined || rawUrl.length === 0) return { ok: false, reason: 'url required' };
    const url = resolveNavigationUrl(rawUrl, window.location.href);
    if (url === null) return { ok: false, reason: 'only http(s) navigation is allowed' };
    window.location.assign(url);
    return { ok: true, url };
  });
  reg.set(IrisCommand.REFRESH, (args) => {
    if (args['hard'] === true) {
      // Hard reload: navigate to self with a cache-busting param then replace history.
      const url = new URL(window.location.href);
      url.searchParams.set('_iris_reload', String(Date.now()));
      window.location.replace(url.toString());
    } else {
      window.location.reload();
    }
    return { ok: true };
  });
  return reg;
}
