/**
 * The systematic explorer: every state the app can reach from its start page, breadth first.
 *
 * The crawl clicks what is on one page; the model-driven harness clicks what a model finds
 * interesting. Neither can promise it did not skip something, and "don't skip anything" is the
 * requirement. This walks the app's STATE GRAPH instead:
 *
 * - A state is a route plus the set of control names on it. An edge is one action. Values and
 *   counts are left out on purpose (every keystroke, every added row would be a new state), so
 *   states that differ only there are one state — see `frontier` for what that costs the report.
 * - Every state is reached by a recorded PATH from a fresh start page, so returning to an
 *   unexplored state is a replay, never a hope that "back" works.
 * - Controls that differ only by a number — the rows of a table — are one control. It is covered
 *   once, which is what keeps a 500-row page from eating the whole budget.
 * - Text fields on a state are filled before its buttons are tried, so a submit is driven with
 *   input rather than dismissed as dead because it refused an empty form. Each field gets its own
 *   value (`fillValue` is told the field's position), so two fields a build swaps do not read alike.
 * - `paths` keeps every click it tried, also a click that kept the same state (a count went up).
 *   A caller that reads the page after each path needs those clicks too.
 *
 * ponytail: breadth-first with a flat action budget, and every edge replays its path from a fresh
 * load. That is O(states × path length), correct and slow; add prefix sharing if it proves too slow.
 * A control that needs a choice (select, combobox) is not driven — it needs a value model.
 */

import {
  EventType,
  asNumber,
  asString,
  isAbsenceDerived,
  isAdvisory,
  parseInteractive,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from '@reticlehq/engine/disagreement/contradictions.js';
import {
  controlKey,
  failedRequests,
  isActivity,
  isConsoleError,
  legitimatelyInert,
  writeKeyOf,
} from './session-fold.js';

/** What one action gives back. */
export interface ActResult {
  ok: boolean;
  /** The events this action caused. */
  events: readonly ReticleEvent[];
  /** The element's source, when the app gives source attribution. */
  source?: { file: string; line: number };
}

/** A page as the explorer reads it: the snapshot tree and the route. */
export interface PageRead {
  tree: string;
  route?: string;
}

/** The attributes `fieldAttrs` reads: what a field takes, for its edge-case values. */
export const FIELD_ATTRS = [
  'type',
  'min',
  'max',
  'maxlength',
  'minlength',
  'pattern',
  'required',
  'inputmode',
] as const;

/** What the explorer needs from a driven page. The tool layer adapts a session to it. */
export interface ExplorePort {
  /** Load the start page fresh. False when it did not come back. */
  reset(): Promise<boolean>;
  /** The interactive tree and route of the page now. */
  look(): Promise<PageRead>;
  /**
   * Act on a control. `settle: false` returns as soon as the action is sent, so the next action
   * runs back to back with it; its late events then arrive with the next action's.
   */
  act(
    ref: string,
    action: 'click' | 'fill',
    value?: string,
    opts?: { settle?: boolean },
  ): Promise<ActResult>;
  /** The whole page, text included. Absent when the port reads only the interactive tree. */
  lookFull?: () => Promise<PageRead>;
  /** Go back to the page before the last action. False when it did not come back. */
  back?: () => Promise<boolean>;
  /** Reload the page now. False when it did not come back. */
  reload?: () => Promise<boolean>;
  /** The `FIELD_ATTRS` the field `control` (a control key) carries, for its edge-case values. */
  fieldAttrs?: (control: string) => Promise<Record<string, string> | undefined>;
  /** Install network mocks ([] clears). Absent, or false, when no driven browser can. */
  mock?: (rules: { urlContains: string; method?: string; abort?: boolean }[]) => Promise<boolean>;
}

export interface Step {
  key: string;
  action: 'click' | 'fill';
  value?: string;
}

export interface ExploredWrite {
  key: string;
  method: string;
  /** A concrete path this write was seen at, for a mock to match. */
  urlPath: string;
  /** How to trigger it from a fresh start page: the last step is the action that fired it. */
  path: Step[];
  /** The state the write was fired from. */
  beforeState: string;
  /** The state the app reached when this write SUCCEEDED — what a failure must not look like. */
  successState: string;
  /**
   * True when the write answered an error or never completed while exploring. `successState` is
   * then where a failure lands, not a success, and nothing can be judged by landing there.
   */
  failed?: boolean;
}

/** One explored state, as the edge-case drive needs it. */
export interface ExploredSurface {
  /** How to reach the state from a fresh start page, before its fields are filled. */
  path: Step[];
  /** What the explorer typed into the state's empty fields, in page order. */
  fills: Step[];
  /** Every text field on the state, in page order: the empty ones and the pre-filled ones. */
  fields: string[];
  /** Each field's `FIELD_ATTRS`, by control key. */
  attrs: Record<string, Record<string, string>>;
  /** The controls the explorer clicked on this state, in page order. */
  order: string[];
  /** The controls whose click sent a request. */
  requests: string[];
  /** The controls whose click sent a write. */
  writes: string[];
  /**
   * The controls whose click showed no activity at all: no request, no DOM change, no route change,
   * no signal. One sample; the edge drive presses each again before it calls one dead.
   */
  inert: string[];
}

export interface ExploreReport {
  states: number;
  actions: number;
  routes: string[];
  seen: string[];
  touched: string[];
  writes: ExploredWrite[];
  anomalies: { kind: string; control: string; detail: string }[];
  /**
   * States found and never explored. Zero means every state the explorer could TELL APART was
   * explored, not that every reachable state was: identity is the route plus the set of control
   * names, so two states that differ only in field values, in how many of a control there are, or
   * in behaviour behind the same controls are one state here and the second is never visited.
   */
  frontier: number;
  /** States whose recorded path no longer replays — the app is not deterministic from its start. */
  unreachable: number;
  budgetExhausted: boolean;
  /** Every click tried, as its path from a fresh start page, in the order the explorer tried them. */
  paths: Step[][];
  /** Every explored state, with its fields, controls and the controls that sent a request. */
  surfaces: ExploredSurface[];
}

export interface ExploreOptions {
  maxActions: number;
  /** What to type into an empty field: its label, and its position among the fields on the state. */
  fillValue: (label: string, index: number) => string;
  /** Called after each click, before the page is read, so behaviour driven by a timer can show. */
  wait?: () => Promise<void>;
}

/** Roles that take typed input. */
const TYPED = /^(?:textbox|searchbox|spinbutton)\b/;
/** Roles that need a value model this explorer does not have, and are left alone. */
const CHOOSER = /^(?:combobox|listbox|option|slider)\b/;
const FAILED_STATUS = 400;
/** The lowest status of an answer that is not an error. 0 is a request that never completed. */
const OK_MIN = 200;

interface Control {
  ref: string;
  key: string;
  /** The field already holds a value — pre-filled credentials, a default. Typing over it breaks it. */
  holdsValue: boolean;
  /** The snapshot line, with the states (`[disabled]`) the key leaves out. */
  desc: string;
}

/** A route without its query: `?__reticle_opened=1` and friends are not a different page. */
const pathOf = (route: string | undefined): string | undefined => route?.split('?')[0];

export function controlsOf(tree: string): Control[] {
  return parseInteractive(tree)
    .filter((item) => item.ref.length > 0)
    .map((item) => ({
      ref: item.ref,
      key: controlKey(item.desc),
      holdsValue: /\[value="[^"]+"/.test(item.desc),
      desc: item.desc,
    }));
}

export function stateKey(route: string | undefined, controls: readonly Control[]): string {
  return `${pathOf(route) ?? ''}|${[...new Set(controls.map((c) => c.key))].sort().join('\n')}`;
}

export async function explore(port: ExplorePort, opts: ExploreOptions): Promise<ExploreReport> {
  let actions = 0;
  let unreachable = 0;
  const routes = new Set<string>();
  const seen = new Set<string>();
  const touched = new Set<string>();
  const writes = new Map<string, ExploredWrite>();
  const anomalies: ExploreReport['anomalies'] = [];
  const explored = new Set<string>();
  const queued = new Set<string>();
  const queue: { path: Step[]; key?: string }[] = [{ path: [] }];
  const paths: Step[][] = [];
  const surfaces: ExploredSurface[] = [];
  const spent = (): boolean => actions >= opts.maxActions;

  const act = async (ref: string, action: 'click' | 'fill', value?: string): Promise<ActResult> => {
    actions += 1;
    return port.act(ref, action, value);
  };

  const goTo = (path: readonly Step[]): Promise<boolean> => replayPath(port, path, act, spent);

  while (queue.length > 0 && !spent()) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }
    if (!(await goTo(node.path))) {
      if (!spent()) {
        unreachable += 1;
      }
      continue;
    }
    const here = await port.look();
    const controls = controlsOf(here.tree);
    const key = stateKey(here.route, controls);
    if (explored.has(key)) {
      continue;
    }
    explored.add(key);
    const where = pathOf(here.route);
    if (where !== undefined) {
      routes.add(where);
    }
    for (const c of controls) {
      seen.add(c.key);
    }

    // Only EMPTY fields. The first drive of the fixture typed placeholders over the login form's
    // correct pre-filled credentials, got a 401, and never left the first page.
    const fields = [...new Set(controls.filter((c) => TYPED.test(c.key)).map((c) => c.key))];
    const typed = controls.filter((c) => TYPED.test(c.key) && !c.holdsValue);
    const fills: Step[] = typed.map((c, index) => ({
      key: c.key,
      action: 'fill',
      value: opts.fillValue(c.key, index),
    }));
    const attrs: ExploredSurface['attrs'] = {};
    // Every field, the pre-filled ones too: the explorer leaves a pre-filled field alone, but its
    // edge values are still worth typing. A login form whose fields came filled got none.
    for (const field of fields) {
      const read = await port.fieldAttrs?.(field);
      if (read !== undefined) {
        attrs[field] = read;
      }
    }
    // Fills first, then the targets: valid input can reveal the button that moves on (a Continue,
    // a Submit), and a list drawn before the fill would never contain it.
    const fillHere = async (): Promise<Control[]> => {
      const before = controlsOf((await port.look()).tree);
      for (const fill of fills) {
        const field = before.find((c) => c.key === fill.key);
        if (field !== undefined && !spent()) {
          await act(field.ref, 'fill', fill.value);
          touched.add(fill.key);
        }
      }
      return 0 < fills.length ? controlsOf((await port.look()).tree) : before;
    };
    const ready = await fillHere();
    for (const c of ready) {
      seen.add(c.key);
    }
    // Every control of THIS state, once. Not filtered by what other states touched: a "Save" on
    // another screen is another control, and skipping it left reachable writes undriven.
    const untried = [
      ...new Set(ready.filter((c) => !TYPED.test(c.key) && !CHOOSER.test(c.key)).map((c) => c.key)),
    ];
    const surface: ExploredSurface = {
      path: node.path,
      fills,
      fields,
      attrs,
      order: untried,
      requests: [],
      writes: [],
      inert: [],
    };
    surfaces.push(surface);
    // Controls no state has tried yet go first. Every page of an app repeats its nav, and trying the
    // nav first on every state spent the budget before a page's own controls were pressed. Each
    // control of the state is still tried; only the order changes.
    const tryOrder = [
      ...untried.filter((c) => !touched.has(c)),
      ...untried.filter((c) => touched.has(c)),
    ];

    for (const [index, target] of tryOrder.entries()) {
      if (spent()) {
        break;
      }
      // The first control is tried on the page already loaded and filled; every other one starts
      // over from the recorded path, because the one before it may have changed or left this state.
      if (index > 0 && !(await goTo(node.path))) {
        break;
      }
      const current = 0 === index ? ready : await fillHere();
      const control = current.find((c) => c.key === target);
      if (control === undefined || spent()) {
        continue;
      }
      const result = await act(control.ref, 'click');
      touched.add(target);
      const path: Step[] = [...node.path, ...fills, { key: target, action: 'click' }];
      paths.push(path);
      await opts.wait?.();
      const after = await port.look();
      const next = stateKey(after.route, controlsOf(after.tree));
      noteWrites(result.events, path, key, next, writes);
      if (result.events.some((e) => EventType.NET_REQUEST === e.type)) {
        surface.requests.push(target);
      }
      if (result.events.some((e) => writeKeyOf(e) !== undefined)) {
        surface.writes.push(target);
      }
      noteAnomalies(result.events, target, anomalies);
      noteDuplicateWrites(result.events, target, anomalies);
      if (
        result.ok &&
        next === key &&
        pathOf(after.route) === where &&
        !result.events.some(isActivity) &&
        !legitimatelyInert(control.desc)
      ) {
        surface.inert.push(target);
      }
      if (!explored.has(next) && !queued.has(next)) {
        queued.add(next);
        queue.push({ path, key: next });
      }
    }
  }

  return {
    states: explored.size,
    actions,
    routes: [...routes],
    seen: [...seen],
    touched: [...touched],
    writes: [...writes.values()],
    anomalies,
    frontier: queue.filter((n) => n.key === undefined || !explored.has(n.key)).length,
    unreachable,
    budgetExhausted: spent(),
    paths,
    surfaces,
  };
}

/**
 * A fresh start page, then the path. False when a step's control is gone or refused. Every state
 * is reached this way, which is what makes returning to one a replay rather than a hope.
 */
export async function replayPath(
  port: ExplorePort,
  path: readonly Step[],
  act: (ref: string, action: 'click' | 'fill', value?: string) => Promise<{ ok: boolean }>,
  spent: () => boolean,
): Promise<boolean> {
  if (!(await port.reset())) {
    return false;
  }
  for (const step of path) {
    if (spent()) {
      return false;
    }
    const target = controlsOf((await port.look()).tree).find((c) => c.key === step.key);
    if (target === undefined) {
      return false;
    }
    if (!(await act(target.ref, step.action, step.value)).ok) {
      return false;
    }
  }
  return true;
}

function noteWrites(
  events: readonly ReticleEvent[],
  path: Step[],
  beforeState: string,
  successState: string,
  writes: Map<string, ExploredWrite>,
): void {
  for (const event of events) {
    const key = writeKeyOf(event);
    if (key === undefined || writes.has(key)) {
      continue;
    }
    const [method = '', urlPath = ''] = key.split(' ');
    const url = event.data['url'];
    const concrete = 'string' === typeof url ? new URL(url, 'http://localhost').pathname : urlPath;
    const status = asNumber(event.data['status']);
    const failed = status === undefined || status < OK_MIN || status >= FAILED_STATUS;
    writes.set(key, {
      key,
      method,
      urlPath: concrete,
      path,
      beforeState,
      successState,
      ...(failed ? { failed } : {}),
    });
  }
}

/** HTTP answers that refuse the credentials. A client sends the write again after one by design. */
const AUTH_REFUSED: ReadonlySet<number> = new Set([401, 403]);
const DUPLICATE_REQUEST = 'duplicate-request';

/**
 * One action that sent the same write two or more times, whatever the server answered. A second
 * copy sent after the server refused the credentials of the first is the client's retry, not a
 * duplicate: the first did no work.
 */
export function noteDuplicateWrites(
  events: readonly ReticleEvent[],
  control: string,
  anomalies: ExploreReport['anomalies'],
): void {
  // Each request once, by its id: a write still in flight has only its `net.pending` here, and one
  // that answered has both. A slow write sent twice is still two sends.
  const sent = new Map<string, Set<string>>();
  const retried = new Set<string>();
  for (const [index, e] of events.entries()) {
    const key = sentWriteKeyOf(e);
    if (key === undefined) {
      continue;
    }
    if (AUTH_REFUSED.has(asNumber(e.data['status']) ?? 0)) {
      retried.add(key);
    }
    const id = asString(e.data['id']) ?? `#${String(index)}`;
    sent.set(key, (sent.get(key) ?? new Set()).add(id));
  }
  for (const [key, ids] of sent) {
    if (ids.size > 1 && !retried.has(key)) {
      anomalies.push({
        kind: DUPLICATE_REQUEST,
        control,
        detail: `one press sent ${key} ${String(ids.size)} times`,
      });
    }
  }
}

/** The write a request or a request still in flight sends, as `writeKeyOf` spells it. */
function sentWriteKeyOf(e: ReticleEvent): string | undefined {
  if (EventType.NET_PENDING === e.type) {
    return writeKeyOf({ ...e, type: EventType.NET_REQUEST });
  }
  return writeKeyOf(e);
}

/** The faults in an action's events: page errors, requests at or above `floor`, contradictions. */
export function noteAnomalies(
  events: readonly ReticleEvent[],
  control: string,
  anomalies: ExploreReport['anomalies'],
  floor = FAILED_STATUS,
): void {
  const list = [...events];
  for (const e of list.filter(isConsoleError)) {
    anomalies.push({
      kind: 'console-error',
      control,
      detail: asString(e.data['message']) ?? e.type,
    });
  }
  for (const e of failedRequests(list, floor)) {
    anomalies.push({
      kind: 'failed-request',
      control,
      detail: `${asString(e.data['method']) ?? ''} ${asString(e.data['url']) ?? ''} → ${String(asNumber(e.data['status']) ?? '')}`,
    });
  }
  for (const c of findContradictions(list, { actionSince: 0 })) {
    if (isAdvisory(c.kind) || isAbsenceDerived(c.kind)) {
      continue;
    }
    anomalies.push({ kind: c.kind, control, detail: `${c.claim}, but ${c.counter}` });
  }
}
