/**
 * Answers the bridge's commands for an application, so the tools an agent already has for a web
 * page (look, act, act and wait, assert) work on a desktop application.
 *
 * It is strict where the browser is generous: a name matches only when it is equal, and a state
 * this realm cannot read is an error, not a guess. A check that cannot be decided must come back
 * as "not known". A wrong `yes` costs more than a missing one.
 */
import { basename } from 'node:path';

import { diffSnapshots } from '@reticlehq/cli-realm';
import type { Snapshot, WorkspacePort } from '@reticlehq/cli-realm';
import {
  ActionType,
  ElementState,
  EventType,
  QueryBy,
  ReticleCommand,
  outwardActionOf,
  outwardRefusal,
} from '@reticlehq/core';

import { ActKind, ActRefusal, Delivery, Reach } from '../driver.js';
import type { ActOutcome, UiDriver } from '../driver.js';
import { ChangeKind, effectOf } from '../effect.js';
import type { Change } from '../effect.js';
import { RefTable, writeWindows } from '../lines.js';
import { UiRole, isAddressable, placeShown } from '../ui-node.js';
import type { Placed, UiNode } from '../ui-node.js';

export type Emit = (type: EventType, data: Record<string, unknown>) => void;

export interface PeerCommandsDeps {
  driver: UiDriver;
  /** Sends one event to the bridge. Called before the answer to the action that caused it. */
  emit: Emit;
  /**
   * Folders to watch. A file that changes there during an action is sent as a signal, so a claim
   * can require the file and not only the words the application shows.
   */
  workspace?: WorkspacePort;
}

/** An application has one screen for the server: it has no address a caller can go to. */
const ROUTE = '/';
/** Room for an effect that comes up to a second late, and then the quiet time after it. */
const DEFAULT_SETTLE_MS = 1500;
/** How far one `dy` scroll moves the bar: a tenth of its range. */
const SCROLL_STEP = 0.1;
/** Each check is one question to the operating system. A search this wide is not a check. */
const MAX_REACH_CHECKS = 8;
const SettleReason = { TIMEOUT: 'timeout' } as const;
const Field = { VALUE: 'value', STATES: 'states' } as const;

/**
 * One signal for each file an action changed. The name is `file.` and the kind of change:
 * `file.written`, `file.modified`, `file.deleted`, `file.mode-changed`. The data is the file name,
 * its path and its size.
 */
export const FILE_SIGNAL_PREFIX = 'file.';

/** The commands this realm answers. The peer declares exactly these to the bridge. */
export const PEER_COMMANDS = [
  ReticleCommand.SNAPSHOT,
  ReticleCommand.QUERY,
  ReticleCommand.MATCH,
  ReticleCommand.INSPECT,
  ReticleCommand.ACT,
  ReticleCommand.ACT_SEQUENCE,
  ReticleCommand.SCROLL,
  ReticleCommand.CAPABILITIES,
] as const;

const KIND_OF: Readonly<Partial<Record<string, ActKind>>> = {
  [ActionType.CLICK]: ActKind.PRESS,
  [ActionType.FILL]: ActKind.SET,
  [ActionType.TYPE]: ActKind.TYPE,
  [ActionType.PRESS]: ActKind.KEY,
};
/** The actions this realm does. The peer declares exactly these to the bridge. */
export const PEER_ACTIONS: readonly string[] = [...Object.keys(KIND_OF), ActionType.SCROLL];

type Args = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}
function record(value: unknown): Args {
  return 'object' === typeof value && value !== null ? (value as Args) : {};
}

function intersects(a: UiNode['frame'], b: UiNode['frame']): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

interface Seen extends Placed {
  /** The element has a size and is inside its window. It says nothing about a window on top. */
  visible: boolean;
  /** The name of the dialog the element is in, or an empty string. */
  dialog: string;
}

/** What is on the screen. An element with no place on it, as in a closed menu, is not here. */
function see(root: UiNode): Seen[] {
  const placed = placeShown(root).shown;
  const byKey = new Map(placed.map((p) => [p.key, p]));
  return placed.map((p) => {
    let window: Placed | undefined = p;
    while (
      window !== undefined &&
      window.node.role !== 'window' &&
      window.parentKey !== undefined
    ) {
      window = byKey.get(window.parentKey);
    }
    let dialog: Placed | undefined = p;
    while (
      dialog !== undefined &&
      dialog.node.role !== 'dialog' &&
      dialog.parentKey !== undefined
    ) {
      dialog = byKey.get(dialog.parentKey);
    }
    const frame = p.node.frame;
    const sized = frame !== undefined && frame[2] > 0 && frame[3] > 0;
    const inside = 'window' === window?.node.role ? intersects(frame, window.node.frame) : sized;
    return {
      ...p,
      visible: sized && inside,
      dialog: 'dialog' === dialog?.node.role ? dialog.node.name : '',
    };
  });
}

const READ_STATE: Readonly<Partial<Record<string, (seen: Seen) => boolean>>> = {
  [ElementState.PRESENT]: () => true,
  [ElementState.VISIBLE]: (s) => s.visible,
  [ElementState.HIDDEN]: (s) => !s.visible,
  [ElementState.ENABLED]: (s) => !s.node.states.includes(ElementState.DISABLED),
  [ElementState.DISABLED]: (s) => s.node.states.includes(ElementState.DISABLED),
  [ElementState.CHECKED]: (s) => s.node.states.includes(ElementState.CHECKED),
  [ElementState.FOCUSED]: (s) => s.node.states.includes(ElementState.FOCUSED),
};

interface ActResult {
  ok: true;
  ref: string;
  action: string;
  dispatched: true;
  settled: boolean;
  settleReason: string | null;
  effect: Record<string, unknown>;
  role: string;
  name: string;
}

export class PeerCommands {
  readonly #deps: PeerCommandsDeps;
  readonly #refs = new RefTable();
  /** The watched folders at the last look. Absent before the first one. */
  #files: Snapshot | undefined;
  constructor(deps: PeerCommandsDeps) {
    this.#deps = deps;
    // The first look. A file that is there now is not a change.
    this.sendFileChanges();
  }

  /**
   * Sends one signal for each file in the watched folders that changed since the last look.
   *
   * It is called after each action, and the peer calls it on a timer too. An application can
   * write a file a moment after the action is finished. A signal that is sent only inside the
   * action misses that file, and a claim that waits for it then fails for a file that is there.
   */
  sendFileChanges(): void {
    const workspace = this.#deps.workspace;
    if (workspace === undefined) {
      return;
    }
    const now = workspace.snapshot();
    for (const file of diffSnapshots(this.#files ?? now, now)) {
      this.#deps.emit(EventType.SIGNAL, {
        name: `${FILE_SIGNAL_PREFIX}${file.kind}`,
        data: { file: basename(file.path), path: file.path, size: file.after?.size ?? 0 },
      });
    }
    this.#files = now;
  }

  /**
   * The answer to one command. It throws when the command fails; the peer sends the words on.
   *
   * `outward` comes with a command the Harness sent: the outward actions (send, delete, pay) its
   * journey asks for. No other outward control is pressed. Absent: an agent or a saved flow sent
   * the command, and there is no limit here.
   */
  async answer(name: string, args: Args, outward?: readonly string[]): Promise<unknown> {
    switch (name) {
      case ReticleCommand.SNAPSHOT:
        return this.#snapshot();
      case ReticleCommand.QUERY:
        return this.#query(args, undefined);
      case ReticleCommand.MATCH:
        return this.#match(args);
      case ReticleCommand.INSPECT:
        return this.#inspect(text(args['ref']) ?? '');
      case ReticleCommand.ACT:
        return this.#act(args, outward);
      case ReticleCommand.ACT_SEQUENCE:
        return this.#sequence(Array.isArray(args['steps']) ? args['steps'] : [], outward);
      case ReticleCommand.SCROLL:
        return this.#scroll(args);
      case ReticleCommand.CAPABILITIES:
        return { testids: [], signals: [], stores: [], flows: [] };
      default:
        throw new Error(`the computer-use realm does not answer ${name}`);
    }
  }

  async #snapshot(): Promise<unknown> {
    const read = await this.#deps.driver.read();
    const written = writeWindows(read.root, this.#refs);
    return {
      tree: written.tree,
      status: { route: ROUTE, title: this.#deps.driver.subject().app },
      nodes: written.tree.split('\n').length,
      truncated: false,
      // Elements with no place on the screen (closed menus) are left out, here and in a search.
      omitted: written.omitted,
      // Zero: the window is closed, or it is on another Space, which this realm cannot read.
      windows: see(read.root).filter((s) => s.node.role === UiRole.WINDOW).length,
      ...(read.windowsNotOnScreen === undefined || 0 === read.windowsNotOnScreen
        ? {}
        : {
            next: `${String(read.windowsNotOnScreen)} window(s) of this application are on another Space or made small. They cannot be read from here. Ask the person to bring the application to this Space.`,
          }),
      unread: read.unread,
    };
  }

  #describe(seen: Seen): Record<string, unknown> {
    const states: string[] = [...seen.node.states];
    states.push(seen.visible ? ElementState.VISIBLE : ElementState.HIDDEN);
    if (!seen.node.states.includes(ElementState.DISABLED)) {
      states.push(ElementState.ENABLED);
    }
    return {
      ref: this.#refs.refFor(seen.key),
      role: seen.node.role,
      name: seen.node.name,
      ...(seen.node.value === undefined ? {} : { value: seen.node.value }),
      states,
      visible: seen.visible,
    };
  }

  async #find(query: Args): Promise<Seen[]> {
    const by = text(query['by']);
    const value = text(query['value']);
    const role = by === QueryBy.ROLE ? value : text(query['role']);
    const name = by === QueryBy.LABEL ? value : (text(query['name']) ?? text(query['label']));
    const wanted = by === QueryBy.TEXT ? value : text(query['text']);
    if (role === undefined && name === undefined && wanted === undefined) {
      throw new Error(
        'the computer-use realm finds an element by role, name or text. This query has none of them.',
      );
    }
    const exact = true === query['matchCase'];
    const fold = (s: string): string => (exact ? s : s.toLowerCase());
    const read = await this.#deps.driver.read();
    return see(read.root).filter(
      (s) =>
        isAddressable(s.node) &&
        (role === undefined || role === s.node.role) &&
        (name === undefined || name === s.node.name) &&
        (wanted === undefined ||
          fold(`${s.node.name} ${s.node.value ?? ''}`).includes(fold(wanted))),
    );
  }

  async #query(
    args: Args,
    state: string | undefined,
  ): Promise<{ elements: unknown[]; count: number }> {
    let found = await this.#find(args);
    if (state !== undefined) {
      const holds = READ_STATE[state];
      if (holds === undefined) {
        throw new Error(`the state ${state} is not read by the computer-use realm`);
      }
      if (state === ElementState.HIDDEN) {
        // Hidden is the other side of visible, by the same two facts: no place in its window, or
        // a place that something covers. A check and a click must not disagree about an element.
        const placed = found.filter((s) => s.visible);
        const seen = new Set(await this.#uncovered(placed));
        found = found.filter((s) => !seen.has(s));
      } else {
        found = found.filter(holds);
        if (state === ElementState.VISIBLE) {
          found = await this.#uncovered(found);
        }
      }
    }
    const limit = 'number' === typeof args['limit'] ? args['limit'] : found.length;
    return { elements: found.slice(0, limit).map((s) => this.#describe(s)), count: found.length };
  }

  /**
   * Of the elements that have a size and are in their window, those that nothing is on top of.
   *
   * "Visible" means a person can see it. A window of another application over this one hides an
   * element as well as a closed dialog does, and the tree does not say so: the window server does.
   * When the operating system cannot say, the check fails with words, and the caller gets "not
   * known". It never gets a `yes` for an element nobody could see.
   */
  async #uncovered(found: readonly Seen[]): Promise<Seen[]> {
    if (found.length > MAX_REACH_CHECKS) {
      throw new Error(
        `${String(found.length)} elements match. The computer-use realm checks each one for a window on top, and it checks ${String(MAX_REACH_CHECKS)} at most. Name one element.`,
      );
    }
    const seen: Seen[] = [];
    for (const candidate of found) {
      const answer = await this.#deps.driver.reach(candidate);
      if (answer.reach === Reach.UNKNOWN) {
        throw new Error(
          `could not tell if a person can see ${candidate.node.role} "${candidate.node.name}": ${answer.detail ?? 'the operating system did not answer'}`,
        );
      }
      if (answer.reach === Reach.YES) {
        seen.push(candidate);
      }
    }
    return seen;
  }

  async #match(args: Args): Promise<unknown> {
    const found = await this.#query(record(args['query']), text(args['state']));
    return {
      matched: found.count > 0,
      ...found,
      // The whole name and value are compared, so a text check here is always on the full text.
      ...(true === args['fullText'] ? { fullText: true } : {}),
    };
  }

  /** The element a ref was given for, in a new read. */
  async #resolve(ref: string): Promise<Seen> {
    const key = this.#refs.keyOf(ref);
    const read = await this.#deps.driver.read();
    const seen = key === undefined ? undefined : see(read.root).find((s) => s.key === key);
    if (seen === undefined) {
      throw new Error(`ref '${ref}' no longer resolves to an element`);
    }
    return seen;
  }

  async #inspect(ref: string): Promise<unknown> {
    const seen = await this.#resolve(ref);
    const frame = seen.node.frame;
    return {
      ...this.#describe(seen),
      ...(frame === undefined
        ? {}
        : { box: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] } }),
    };
  }

  #send(change: Change): void {
    const who = { role: change.role, name: change.name };
    if (change.kind === ChangeKind.NEW) {
      this.#deps.emit(EventType.DOM_ADDED, who);
    } else if (change.kind === ChangeKind.GONE) {
      this.#deps.emit(EventType.DOM_REMOVED, who);
    } else {
      for (const [attr, pair] of [
        [Field.VALUE, change.value],
        [Field.STATES, change.states],
      ] as const) {
        if (pair !== undefined) {
          this.#deps.emit(EventType.DOM_ATTR, { ...who, attr, old: pair[0], value: pair[1] });
        }
      }
    }
  }

  /**
   * Does one action, and sends what it changed before the caller gets an answer: each change in
   * the tree as an event, and each file written in a watched folder as a signal.
   */
  async #drive(
    target: Seen,
    ref: string,
    kind: ActKind,
    value: string | undefined,
    how: { delivery: Delivery; budgetMs: number },
  ): Promise<{ outcome: ActOutcome; changes: Change[] }> {
    const workspace = this.#deps.workspace;
    // What changed before this action is not its effect: say it first, on its own.
    this.sendFileChanges();
    const outcome = await this.#deps.driver.act({
      target,
      kind,
      ...(value === undefined ? {} : { value }),
      ...how,
      watch: workspace?.roots ?? [],
    });
    if (outcome.refused === ActRefusal.STALE) {
      throw new Error(`ref '${ref}' no longer resolves to an element`);
    }
    if (outcome.refused === ActRefusal.UNREACHABLE) {
      throw new Error(
        `a person cannot reach ${target.node.role} "${target.node.name}": ${outcome.detail ?? 'another view or window'} is over it.`,
      );
    }
    if (outcome.refused !== undefined || !outcome.delivered) {
      throw new Error(
        `${target.node.role} "${target.node.name}" did not take the action: ${outcome.refused ?? 'the operating system refused it'}.`,
      );
    }
    const { changes } = effectOf(outcome.before.root, outcome.after.root);
    for (const change of changes) {
      this.#send(change);
    }
    this.sendFileChanges();
    return { outcome, changes };
  }

  /**
   * Scrolls the scroll area that holds an element, by moving its scroll bar. No wheel event is
   * sent: a wheel event does not reach an application that is not in front, and it would use the
   * pointer of the person at the machine.
   *
   * `fraction` is the place of the bar, 0 to 1. `dy` moves the bar one step in its direction; the
   * realm does not know the height of the content, so it cannot scroll by pixels, and it says so.
   */
  async #scroll(args: Args): Promise<Record<string, unknown>> {
    const ref = text(args['ref']);
    const read = await this.#deps.driver.read();
    const seen = see(read.root);
    const key = ref === undefined ? undefined : this.#refs.keyOf(ref);
    if (ref !== undefined && !seen.some((s) => s.key === key)) {
      throw new Error(`ref '${ref}' no longer resolves to an element`);
    }
    // The first vertical bar that is in the element's own line of parents, or the first of all.
    const bars = seen.filter(
      (s) =>
        s.node.role === UiRole.SCROLLBAR &&
        s.node.frame !== undefined &&
        s.node.frame[3] > s.node.frame[2],
    );
    const bar =
      key === undefined
        ? bars[0]
        : bars
            .filter((b) => b.parentKey !== undefined && `${key}/`.startsWith(`${b.parentKey}/`))
            .at(-1);
    if (bar === undefined) {
      throw new Error('there is no scroll bar to move for this element');
    }
    const now = Number(bar.node.value ?? '0');
    const fraction = args['fraction'];
    const dy = args['dy'];
    let to = now;
    if ('number' === typeof fraction) {
      to = fraction;
    } else if ('number' === typeof dy && dy !== 0) {
      to = now + Math.sign(dy) * SCROLL_STEP;
    }
    to = Math.min(1, Math.max(0, to));
    const { changes } = await this.#drive(
      bar,
      this.#refs.refFor(bar.key),
      ActKind.SET,
      String(to),
      {
        // A person scrolls with a wheel over the content, not by a click on the bar, and the bar
        // of a modern scroll area is not drawn until then. So no reach check is made on the bar.
        delivery: Delivery.DIRECT,
        budgetMs: DEFAULT_SETTLE_MS,
      },
    );
    return {
      scrolled: changes.length > 0,
      atEnd: 0 === to || 1 === to,
      fraction: to,
      // Declared, because the caller asked for pixels and got a step.
      ...('number' === typeof dy && 'number' !== typeof fraction
        ? { stepInsteadOfPixels: SCROLL_STEP }
        : {}),
    };
  }

  /**
   * Several actions in one command, so a model turn drives more than one step. It stops at the
   * first action that fails, and the failure names the step.
   */
  async #sequence(steps: readonly unknown[], outward?: readonly string[]): Promise<unknown> {
    const done: ActResult[] = [];
    for (const [index, step] of steps.entries()) {
      try {
        done.push(await this.#act(record(step), outward));
      } catch (error) {
        const words = error instanceof Error ? error.message : String(error);
        throw new Error(`step ${String(index + 1)} of ${String(steps.length)}: ${words}`, {
          cause: error,
        });
      }
    }
    return {
      ok: true,
      count: done.length,
      effects: done.map((result) => result.effect),
      steps: done.map(({ effect: _effect, ok: _ok, ...step }) => step),
    };
  }

  async #act(args: Args, allowed?: readonly string[]): Promise<ActResult> {
    const ref = text(args['ref']) ?? '';
    const action = text(args['action']) ?? '';
    if (action === ActionType.SCROLL) {
      // The same scroll as the `scroll` command, with the answer in the shape of an action.
      const target = await this.#resolve(ref);
      const moved = await this.#scroll({ ...record(args['args']), ref });
      return {
        ok: true,
        ref,
        action,
        dispatched: true,
        settled: true,
        settleReason: null,
        effect: { dispatched: true, targetMatched: true, ...moved },
        role: target.node.role,
        name: target.node.name,
      };
    }
    const kind = KIND_OF[action];
    if (kind === undefined) {
      throw new Error(
        `the computer-use realm does not have the action ${action}. It has: ${PEER_ACTIONS.join(', ')}.`,
      );
    }
    const target = await this.#resolve(ref);
    if (allowed !== undefined) {
      // The dialog's name is part of the meaning: "OK" in "Delete the project?" is a delete.
      const outward = outwardActionOf(`${target.node.name} ${target.dialog}`, target.node.role);
      if (outward !== undefined && !allowed.includes(outward)) {
        throw new Error(outwardRefusal(outward));
      }
    }
    const more = record(args['args']);
    const modifiers = Array.isArray(more['modifiers']) ? more['modifiers'].map(String) : [];
    const key = text(more['text']);
    // `fill` gives `value`. `type` gives `text`. `press` gives the key in `text`, with modifiers.
    const value =
      kind === ActKind.KEY && key !== undefined
        ? [...modifiers, key].join('+')
        : (text(more['value']) ?? key);
    const { outcome, changes } = await this.#drive(target, ref, kind, value, {
      delivery: Delivery.USER_PATH,
      budgetMs: 'number' === typeof more['settleMs'] ? more['settleMs'] : DEFAULT_SETTLE_MS,
    });
    return {
      ok: true,
      ref,
      action,
      dispatched: true,
      settled: outcome.settled,
      settleReason: outcome.settled ? null : SettleReason.TIMEOUT,
      effect: {
        dispatched: true,
        targetMatched: true,
        visible: target.visible,
        enabled: true,
        valueChanged: changes.some((c) => c.value !== undefined),
        // Every change in the application, not only those inside the target.
        domMutatedWithin: changes.length,
        occluded: !outcome.reachable,
      },
      role: target.node.role,
      name: target.node.name,
    };
  }
}
