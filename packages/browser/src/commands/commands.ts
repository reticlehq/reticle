import {
  ActionType,
  ComponentStateReason,
  DANGEROUS_ACTION_CONFIRM_ARG,
  ElementQuerySchema,
  ReticleCommand,
  SnapshotMode,
  TRANSPORT_LIMITS,
  selectPath,
  capDepth,
  type ComponentStateResult,
  type ElementQuery,
  type ElementState,
} from '@reticlehq/protocol';
import { buildSnapshot } from '../dom/snapshot.js';
import { matchQuery, runQuery } from '../dom/query.js';
import {
  executeAction,
  executeSequence,
  dispatchWebMcp,
  type ActionStep,
} from '../actions/actions.js';
import { describe } from '../dom/a11y.js';
import { themeReport } from '../dom/theme.js';
import { refs } from '../dom/refs.js';
import { identifyComponent, readComponentState } from '../registry/adapters.js';
import { readStores, storeNames } from '../registry/stores.js';
import { getCapabilities } from '../registry/capabilities.js';
import { freezeClock, advanceClock, resetClock, isClockFrozen } from '../timers/clock.js';
import { scrollContainer } from '../actions/scroll.js';

export type CommandHandler = (args: Record<string, unknown>) => unknown;

/** Query param appended on a hard reload to bypass the browser cache. */
const RELOAD_CACHE_BUST_PARAM = '_reticle_reload';

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
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
    // Theme compliance vs the app's design tokens (off-theme colors a DOM tool can't judge).
    theme: cs !== null ? themeReport(cs) : null,
    component,
  };
}

/** True if the node (or an ancestor) is part of Reticle's own injected UI (HUD, glow, cursor, flag
 * button, …). Reticle's overlay must never count as occluding the app — a control sitting under the
 * HUD is a false "occluded" reading, since the HUD is not part of the app the user actually sees. */
function isReticleUi(node: Element | null): boolean {
  for (let n: Element | null = node; n !== null; n = n.parentElement) {
    for (const attr of Array.from(n.attributes)) {
      if (attr.name.startsWith('data-reticle')) return true;
    }
  }
  return false;
}

/** Whether a NON-Reticle element covers this one's center point (a transparent overlay / z-index bug). */
function isOccluded(el: Element, rect: DOMRect): boolean {
  if (rect.width === 0 || rect.height === 0) return false; // a 0×0 box is a different bug (size)
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== 'function') return false;
  const top = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  // Reticle's own HUD sits at a high z-index and must never read as occluding the app.
  if (top === null || isReticleUi(top)) return false;
  return top !== el && !el.contains(top);
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
 * Stores are the reliable path. The `ref` component read is bounded: a stale ref, no
 * adapter, or an adapter returning a non-conforming value all collapse to a structured
 * `{ ok: false, reason }` — never a raw (possibly circular) object that could hang serialization.
 *
 * `path`/`depth` are applied HERE, in the page, BEFORE the value crosses the transport — so a scoped
 * read of a huge store (e.g. `deployments.0.status` on a 500-row store) returns only the small
 * sub-tree and is never truncated. (Previously selection ran server-side, AFTER the whole store had
 * already been size-capped in transit, which silently lost any field after a large array.)
 */
function readState(
  ref: string | undefined,
  store: string | undefined,
  path: string | undefined,
  depth: number | undefined,
): unknown {
  const stores = readStores(store);
  const names = storeNames();

  // Scoped read: walk `path` into the named store (or the whole {stores} when no store is given) and
  // cap depth — entirely in-page, so only the result crosses the wire.
  if (path !== undefined || depth !== undefined) {
    const base = store !== undefined ? stores[store] : { stores, storeNames: names };
    const selection = path !== undefined ? selectPath(base, path) : { found: true, value: base };
    const value =
      selection.found && depth !== undefined ? capDepth(selection.value, depth) : selection.value;
    return {
      store,
      path,
      found: selection.found,
      value,
      ...('availableKeys' in selection ? { availableKeys: selection.availableKeys } : {}),
      storeNames: names,
    };
  }

  const result: {
    stores: Record<string, unknown>;
    storeNames: string[];
    component?: ComponentStateResult;
  } = {
    stores,
    storeNames: names,
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
  reg.set(ReticleCommand.SNAPSHOT, (args) =>
    buildSnapshot({
      scope: str(args['scope']),
      mode: (str(args['mode']) as SnapshotMode | undefined) ?? SnapshotMode.FULL,
    }),
  );
  reg.set(ReticleCommand.QUERY, (args) => runQuery(queryFromArgs(args)));
  reg.set(ReticleCommand.MATCH, (args) =>
    matchQuery(
      ElementQuerySchema.parse(record(args['query'])),
      str(args['state']) as ElementState | undefined,
    ),
  );
  reg.set(ReticleCommand.ACT, (args) => {
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
  reg.set(ReticleCommand.ACT_SEQUENCE, (args) =>
    executeSequence((Array.isArray(args['steps']) ? args['steps'] : []) as ActionStep[]),
  );
  reg.set(ReticleCommand.INSPECT, (args) => inspect(str(args['ref']) ?? ''));
  reg.set(ReticleCommand.ANIMATIONS, () => listAnimations());
  reg.set(ReticleCommand.CLOCK, (args) => {
    if (args['reset'] === true) {
      resetClock();
    } else {
      if (args['freeze'] === true) freezeClock();
      const adv = args['advanceMs'];
      if (typeof adv === 'number') advanceClock(adv);
    }
    return { frozen: isClockFrozen() };
  });
  reg.set(ReticleCommand.STATE_READ, (args) =>
    readState(str(args['ref']), str(args['store']), str(args['path']), num(args['depth'])),
  );
  reg.set(ReticleCommand.CAPABILITIES, () => getCapabilities());
  reg.set(ReticleCommand.SCROLL, (args) => {
    const dy = args['dy'];
    const fraction = args['fraction'];
    return scrollContainer(
      str(args['ref']),
      typeof dy === 'number' ? dy : undefined,
      typeof fraction === 'number' ? fraction : undefined,
    );
  });
  reg.set(ReticleCommand.NAVIGATE, (args) => {
    const rawUrl = str(args['url']);
    if (rawUrl === undefined || rawUrl.length === 0) return { ok: false, reason: 'url required' };
    const url = resolveNavigationUrl(rawUrl, window.location.href);
    if (url === null) return { ok: false, reason: 'only http(s) navigation is allowed' };
    window.location.assign(url);
    return { ok: true, url };
  });
  reg.set(ReticleCommand.REFRESH, (args) => {
    if (args['hard'] === true) {
      // Hard reload: navigate to self with a cache-busting param then replace history.
      const url = new URL(window.location.href);
      url.searchParams.set(RELOAD_CACHE_BUST_PARAM, String(Date.now()));
      window.location.replace(url.toString());
    } else {
      window.location.reload();
    }
    return { ok: true };
  });
  return reg;
}
