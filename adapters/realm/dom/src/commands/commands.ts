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
} from '@reticlehq/core';
import { buildSnapshot } from '../dom/snapshot.js';
import { matchQuery, runQuery } from '../dom/query.js';
import {
  executeAction,
  executeSequence,
  dispatchWebMcp,
  type ActionStep,
} from '../actions/actions.js';
import { describe } from '../dom/a11y.js';
import { documentHasSourceStamps, sourceFor, formatSource } from '../dom/source.js';
import { themeReport } from '../dom/theme.js';
import { refs } from '../dom/refs.js';
import { editEpoch } from '../edit-epoch.js';
import { isButton, isInput } from '../dom/realm.js';
import { hitTestOccluder } from '../dom/occlusion.js';
import { readStorage } from '../observers/storage.js';
import { captureDesktopWindow } from '../dom/desktop-capture.js';
import { identifyComponent, readComponentState } from '../registry/adapters.js';
import { readStoresWithTruncation, readStoresRaw, storeNames } from '../registry/stores.js';
import { sanitizeWithReport } from '../security/serialization.js';
import { getCapabilities } from '../registry/capabilities.js';
import { freezeClock, advanceClock, resetClock, isClockFrozen } from '../timers/clock.js';
import { scrollContainer } from '../actions/scroll.js';

export type CommandHandler = (args: Record<string, unknown>) => unknown;

/** Query param appended on a hard reload to bypass the browser cache. */
export const RELOAD_CACHE_BUST_PARAM = '_reticle_reload';

function str(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return 'number' === typeof value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return 'object' === typeof value && value !== null ? (value as Record<string, unknown>) : {};
}

function sourceLocation(value: unknown): ElementQuery['source'] {
  if (typeof value !== 'object' || null === value) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj['file'] !== 'string' || typeof obj['line'] !== 'number') return undefined;
  return { file: obj['file'], line: obj['line'], column: num(obj['column']) };
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
    component: str(args['component']),
    scope: str(args['scope']),
    // The THIRD allowlist a query input has to appear in — tool schema, server forward, and here.
    // `self` was in the first two and missing from this one, so a live call returned zero matches on
    // an element that was plainly on the page, with no error to explain it. Same shape as the
    // `attrs` drop below it.
    self: true === args['self'] ? true : undefined,
    attrs: Array.isArray(args['attrs'])
      ? args['attrs'].filter((a): a is string => 'string' === typeof a)
      : undefined,
    source: sourceLocation(args['source']),
  };
}

function inspect(ref: string): unknown {
  const el = refs.resolve(ref);
  // THROW, exactly as executeAction does. Returning an error payload made it a SUCCESSFUL command
  // result, which the server then handed to reticle_inspect's outputSchema (ref/role/name/states/
  // visible all required) — so the MCP layer answered -32602 Output validation error for the most
  // ordinary thing that follows a click. The wording matches actions.ts because the server's
  // recovery table keys off /no longer resolves to an element/ to attach the stale-ref recovery.
  if (null === el) throw new Error(editEpoch.staleRefMessage(ref));
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
  // `describe()` carries the CHEAP source (the nearest babel-stamped ancestor), because it runs per
  // element on paths that describe hundreds at once. inspect is a single-element path, so it takes
  // the adapter's answer first — the component that actually RENDERED this element, not the nearest
  // stamped host. `act` already did this; inspect did not, so the two tools disagreed about the same
  // ref and inspect — the tool you reach for to ask where something lives — was the one saying null.
  const source = formatSource(sourceFor(el, component?.source));
  // Say WHY the source is missing rather than omitting the field and leaving the caller to guess.
  // No stamp anywhere in the document is decisive: the loader is not running, so no element will
  // have one this session, and the fix is a build-config change rather than anything about this
  // element. Only computed when `source` is already absent, so the ordinary path pays nothing.
  const sourceUnavailable =
    source !== undefined
      ? undefined
      : documentHasSourceStamps(el.ownerDocument)
        ? 'This element has no source stamp. Others on the page do, so the stamping loader is running — the nearest stamped ancestor is out of range, or this element is rendered outside instrumented code.'
        : 'No element in this document carries a source stamp, so the stamping loader is not running: an older adapter, a bundler whose hook never ran, or a build the plugin was dropped from. Add @reticlehq/vite-plugin (or @reticlehq/babel-plugin) to the dev build and restart the dev server to get `file:line` back.';
  const scroll = {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: cs?.overflowY ?? 'visible',
  };
  return {
    ...describe(el),
    ...(source !== undefined ? { source } : {}),
    ...(sourceUnavailable !== undefined ? { sourceUnavailable } : {}),
    tag: el.tagName.toLowerCase(),
    href: el.getAttribute('href') ?? undefined,
    formAction:
      isButton(el) || isInput(el) ? (el.form?.getAttribute('action') ?? undefined) : undefined,
    formText: isButton(el) || isInput(el) ? (el.form?.textContent ?? undefined) : undefined,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    // True when another element sits over this one's center point — the click would hit the overlay,
    // not this control (a z-index/overlay bug the DOM tree cannot show).
    occluded: isOccluded(el, rect),
    styles,
    scroll,
    // Theme compliance vs the app's design tokens (off-theme colors a DOM tool can't judge).
    theme: cs !== null ? themeReport(cs) : null,
    component,
  };
}

/** Whether a NON-Reticle element covers this one's center point (a transparent overlay / z-index bug). */
function isOccluded(el: Element, rect: DOMRect): boolean {
  return hitTestOccluder(el, rect) !== null;
}

/** Narrowing guard: an adapter returned a ComponentStateResult (has a boolean `ok`). */
function isComponentStateResult(value: unknown): value is ComponentStateResult {
  return (
    'object' === typeof value && value !== null && 'ok' in value && 'boolean' === typeof value.ok
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
  const names = storeNames();

  // Scoped read: walk `path` into the RAW (uncapped) store, then sanitize only the selected sub-tree.
  // Selecting before the transport cap is what lets a deep/large path (row 250 of a 500-row array)
  // resolve — capping first would truncate the store before selection ever reached the row.
  if (path !== undefined || depth !== undefined) {
    const rawStores = readStoresRaw(store);
    const base = store !== undefined ? rawStores[store] : { stores: rawStores, storeNames: names };
    const selection = path !== undefined ? selectPath(base, path) : { found: true, value: base };
    const selected =
      selection.found && depth !== undefined ? capDepth(selection.value, depth) : selection.value;
    const projected = sanitizeWithReport(selected);
    return {
      store,
      path,
      found: selection.found,
      value: projected.value,
      // Even a SCOPED read can hit the caps when the selected sub-tree is itself large; saying so is
      // what keeps "the list is short" distinguishable from "I shortened the list".
      ...(projected.truncation === undefined ? {} : { truncation: projected.truncation }),
      ...('availableKeys' in selection ? { availableKeys: selection.availableKeys } : {}),
      // How many keys there REALLY were, when the near-miss list is a sample. Without it, 50 names
      // and no marker reads as "the key you asked for does not exist" — the strongest negative
      // signal there is, and a false one when the key is simply number 51.
      ...('totalKeys' in selection ? { totalKeys: selection.totalKeys } : {}),
      storeNames: names,
    };
  }

  const { stores, truncation } = readStoresWithTruncation(store);
  const result: {
    stores: Record<string, unknown>;
    storeNames: string[];
    component?: ComponentStateResult;
    truncation?: Record<string, unknown>;
  } = {
    stores,
    storeNames: names,
  };
  // The whole-store read is where a large store silently became a small one. Present only when a cap
  // actually fired, so an intact read is unchanged and the field's presence is the warning.
  if (truncation !== undefined) result.truncation = truncation;
  if (ref !== undefined && ref.length > 0) {
    const el = refs.resolve(ref);
    if (null === el) {
      result.component = COMPONENT_UNAVAILABLE;
    } else {
      const state = readComponentState(el);
      result.component = isComponentStateResult(state) ? state : COMPONENT_UNAVAILABLE;
    }
  }
  return result;
}

/**
 * Every animation, and WHICH element it drives.
 *
 * Reported from the field: a page with nine concurrent animations returned nine indistinguishable
 * `{playState, currentTime, duration}` rows. `a.effect` was read only for `getTiming()`, never for
 * its `target` — so the tool advertised "targets/timing" and shipped timing alone. A list you cannot
 * index is not a list, and the question this tool exists to answer is "is THAT thing still
 * animating".
 *
 * `describe()` is reused rather than inventing a target shape: it is what `reticle_query` returns,
 * so the descriptor carries a `ref` the agent can pass straight to `reticle_act` — a target you
 * cannot act on would be half an answer.
 */
function listAnimations(): unknown {
  const doc = document as Document & { getAnimations?: () => Animation[] };
  if (typeof doc.getAnimations !== 'function') return { animations: [] };
  const animations = doc.getAnimations().map((a) => {
    const effect = a.effect;
    const timing = effect?.getTiming();
    // A KeyframeEffect's target is legitimately nullable, and only KeyframeEffect has one at all.
    // `null` is reported explicitly: omitting the key would make "this animation has no element"
    // indistinguishable from the bug above, which is the distinction the fix exists to draw.
    const target = (effect as KeyframeEffect | null)?.target ?? null;
    return {
      playState: a.playState,
      currentTime: a.currentTime,
      duration: timing?.duration,
      target: null === target ? null : describe(target),
    };
  });
  return { animations };
}

export function resolveNavigationUrl(rawUrl: string, baseUrl: string): string | null {
  if (0 === rawUrl.length || rawUrl.length > TRANSPORT_LIMITS.MAX_URL_LENGTH) return null;
  try {
    const url = new URL(rawUrl, baseUrl);
    return 'http:' === url.protocol || 'https:' === url.protocol ? url.toString() : null;
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
      // Only the completion re-read sets this: it re-reads a branch the truncated walk stopped
      // BEFORE emitting, so that branch's own line has to come back with its descendants.
      includeRoot: true === args['includeRoot'],
    }),
  );
  reg.set(ReticleCommand.QUERY, (args) => {
    const limit = args['limit'];
    return runQuery(queryFromArgs(args), 'number' === typeof limit ? limit : undefined);
  });
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
        true === inner[DANGEROUS_ACTION_CONFIRM_ARG],
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
    if (true === args['reset']) {
      resetClock();
    } else {
      if (true === args['freeze']) freezeClock();
      const adv = args['advanceMs'];
      if ('number' === typeof adv) advanceClock(adv);
    }
    return { frozen: isClockFrozen() };
  });
  reg.set(ReticleCommand.STATE_READ, (args) =>
    readState(str(args['ref']), str(args['store']), str(args['path']), num(args['depth'])),
  );
  reg.set(ReticleCommand.STORAGE_READ, (args) => readStorage(str(args['area'])));
  reg.set(ReticleCommand.CAPABILITIES, () => getCapabilities());
  reg.set(ReticleCommand.CAPTURE, (args) => captureDesktopWindow(true === args['fullPage']));
  reg.set(ReticleCommand.SCROLL, (args) => {
    const dy = args['dy'];
    const fraction = args['fraction'];
    return scrollContainer(
      str(args['ref']),
      'number' === typeof dy ? dy : undefined,
      'number' === typeof fraction ? fraction : undefined,
    );
  });
  reg.set(ReticleCommand.NAVIGATE, (args) => {
    const rawUrl = str(args['url']);
    if (rawUrl === undefined || 0 === rawUrl.length) return { ok: false, reason: 'url required' };
    const url = resolveNavigationUrl(rawUrl, window.location.href);
    if (null === url) return { ok: false, reason: 'only http(s) navigation is allowed' };
    window.location.assign(url);
    return { ok: true, url };
  });
  reg.set(ReticleCommand.REFRESH, (args) => {
    if (true === args['hard']) {
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
