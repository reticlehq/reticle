/**
 * The systematic explorer: every state the app can reach from its start page, breadth first.
 *
 * The crawl clicks what is on one page; the model-driven harness clicks what a model finds
 * interesting. Neither can promise it did not skip something, and "don't skip anything" is the
 * requirement. This walks the app's STATE GRAPH instead:
 *
 * - A state is a route plus the set of controls on it. An edge is one action.
 * - Every state is reached by a recorded PATH from a fresh start page, so returning to an
 *   unexplored state is a replay, never a hope that "back" works.
 * - Controls that differ only by a number — the rows of a table — are one control. It is covered
 *   once, which is what keeps a 500-row page from eating the whole budget.
 * - Text fields on a state are filled before its buttons are tried, so a submit is driven with
 *   input rather than dismissed as dead because it refused an empty form.
 *
 * ponytail: breadth-first with a flat action budget, and every edge replays its path from a fresh
 * load. That is O(states × path length), correct and slow; add prefix sharing if it proves too slow.
 * A control that needs a choice (select, combobox) is not driven — it needs a value model.
 */

import {
  asNumber,
  asString,
  isAbsenceDerived,
  isAdvisory,
  parseInteractive,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from '@reticlehq/engine/disagreement/contradictions.js';
import { controlKey, failedRequests, isConsoleError, writeKeyOf } from './session-fold.js';

/** What the explorer needs from a driven page. The tool layer adapts a session to it. */
export interface ExplorePort {
  /** Load the start page fresh. False when it did not come back. */
  reset(): Promise<boolean>;
  /** The interactive tree and route of the page now. */
  look(): Promise<{ tree: string; route?: string }>;
  /** Act on a control; the events are the ones this action caused. */
  act(
    ref: string,
    action: 'click' | 'fill',
    value?: string,
  ): Promise<{ ok: boolean; events: readonly ReticleEvent[] }>;
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
}

export interface ExploreReport {
  states: number;
  actions: number;
  routes: string[];
  seen: string[];
  touched: string[];
  writes: ExploredWrite[];
  anomalies: { kind: string; control: string; detail: string }[];
  /** States found and never explored. Zero means the reachable app was covered. */
  frontier: number;
  /** States whose recorded path no longer replays — the app is not deterministic from its start. */
  unreachable: number;
  budgetExhausted: boolean;
}

/** Roles that take typed input. */
const TYPED = /^(?:textbox|searchbox|spinbutton)\b/;
/** Roles that need a value model this explorer does not have, and are left alone. */
const CHOOSER = /^(?:combobox|listbox|option|slider)\b/;
const FAILED_STATUS = 400;

interface Control {
  ref: string;
  key: string;
  /** The field already holds a value — pre-filled credentials, a default. Typing over it breaks it. */
  holdsValue: boolean;
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
    }));
}

export function stateKey(route: string | undefined, controls: readonly Control[]): string {
  return `${pathOf(route) ?? ''}|${[...new Set(controls.map((c) => c.key))].sort().join('\n')}`;
}

export async function explore(
  port: ExplorePort,
  opts: { maxActions: number; fillValue: (label: string) => string },
): Promise<ExploreReport> {
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
  const spent = (): boolean => actions >= opts.maxActions;

  const act = async (
    ref: string,
    action: 'click' | 'fill',
    value?: string,
  ): Promise<{ ok: boolean; events: readonly ReticleEvent[] }> => {
    actions += 1;
    return port.act(ref, action, value);
  };

  const goTo = (path: readonly Step[]): Promise<boolean> => replayPath(port, path, act, spent);

  while (queue.length > 0 && !spent()) {
    const node = queue.shift();
    if (node === undefined) break;
    if (!(await goTo(node.path))) {
      if (!spent()) unreachable += 1;
      continue;
    }
    const here = await port.look();
    const controls = controlsOf(here.tree);
    const key = stateKey(here.route, controls);
    if (explored.has(key)) continue;
    explored.add(key);
    const where = pathOf(here.route);
    if (where !== undefined) routes.add(where);
    for (const c of controls) seen.add(c.key);

    // Only EMPTY fields. The first drive of the fixture typed placeholders over the login form's
    // correct pre-filled credentials, got a 401, and never left the first page.
    const typed = controls.filter((c) => TYPED.test(c.key) && !c.holdsValue);
    const fills: Step[] = typed.map((c) => ({
      key: c.key,
      action: 'fill',
      value: opts.fillValue(c.key),
    }));
    const untried = [
      ...new Set(
        controls
          .filter((c) => !TYPED.test(c.key) && !CHOOSER.test(c.key) && !touched.has(c.key))
          .map((c) => c.key),
      ),
    ];

    for (const [index, target] of untried.entries()) {
      if (spent()) break;
      // The first control is tried on the page already loaded; every other one starts over from
      // the recorded path, because the one before it may have changed or left this state.
      if (index > 0 && !(await goTo(node.path))) break;
      let current = controlsOf((await port.look()).tree);
      for (const fill of fills) {
        const field = current.find((c) => c.key === fill.key);
        if (field !== undefined && !spent()) {
          await act(field.ref, 'fill', fill.value);
          touched.add(fill.key);
        }
      }
      if (0 < fills.length) current = controlsOf((await port.look()).tree);
      const control = current.find((c) => c.key === target);
      if (control === undefined || spent()) continue;
      const result = await act(control.ref, 'click');
      touched.add(target);
      const path: Step[] = [...node.path, ...fills, { key: target, action: 'click' }];
      const after = await port.look();
      const next = stateKey(after.route, controlsOf(after.tree));
      noteWrites(result.events, path, key, next, writes);
      noteAnomalies(result.events, target, anomalies);
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
  if (!(await port.reset())) return false;
  for (const step of path) {
    if (spent()) return false;
    const target = controlsOf((await port.look()).tree).find((c) => c.key === step.key);
    if (target === undefined) return false;
    if (!(await act(target.ref, step.action, step.value)).ok) return false;
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
    if (key === undefined || writes.has(key)) continue;
    const [method = '', urlPath = ''] = key.split(' ');
    const url = event.data['url'];
    const concrete = 'string' === typeof url ? new URL(url, 'http://localhost').pathname : urlPath;
    writes.set(key, { key, method, urlPath: concrete, path, beforeState, successState });
  }
}

function noteAnomalies(
  events: readonly ReticleEvent[],
  control: string,
  anomalies: ExploreReport['anomalies'],
): void {
  const list = [...events];
  for (const e of list.filter(isConsoleError))
    anomalies.push({
      kind: 'console-error',
      control,
      detail: asString(e.data['message']) ?? e.type,
    });
  for (const e of failedRequests(list, FAILED_STATUS))
    anomalies.push({
      kind: 'failed-request',
      control,
      detail: `${asString(e.data['method']) ?? ''} ${asString(e.data['url']) ?? ''} → ${String(asNumber(e.data['status']) ?? '')}`,
    });
  for (const c of findContradictions(list, { actionSince: 0 })) {
    if (isAdvisory(c.kind) || isAbsenceDerived(c.kind)) continue;
    anomalies.push({ kind: c.kind, control, detail: `${c.claim}, but ${c.counter}` });
  }
}
