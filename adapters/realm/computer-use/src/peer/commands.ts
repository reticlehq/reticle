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
import type { WorkspacePort } from '@reticlehq/cli-realm';
import { ActionType, ElementState, EventType, QueryBy, ReticleCommand } from '@reticlehq/core';

import { ActKind, ActRefusal, Delivery } from '../driver.js';
import type { UiDriver } from '../driver.js';
import { ChangeKind, effectOf } from '../effect.js';
import type { Change } from '../effect.js';
import { RefTable, writeWindows } from '../lines.js';
import { isAddressable, place } from '../ui-node.js';
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
const DEFAULT_SETTLE_MS = 1000;
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
  ReticleCommand.CAPABILITIES,
] as const;

const KIND_OF: Readonly<Partial<Record<string, ActKind>>> = {
  [ActionType.CLICK]: ActKind.PRESS,
  [ActionType.FILL]: ActKind.SET,
};
/** The actions this realm does. The peer declares exactly these to the bridge. */
export const PEER_ACTIONS: readonly string[] = Object.keys(KIND_OF);

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
}

function see(root: UiNode): Seen[] {
  const placed = place(root);
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
    const frame = p.node.frame;
    const sized = frame !== undefined && frame[2] > 0 && frame[3] > 0;
    const inside = 'window' === window?.node.role ? intersects(frame, window.node.frame) : sized;
    return { ...p, visible: sized && inside };
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

  constructor(deps: PeerCommandsDeps) {
    this.#deps = deps;
  }

  /** The answer to one command. It throws when the command fails; the peer sends the words on. */
  async answer(name: string, args: Args): Promise<unknown> {
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
        return this.#act(args);
      case ReticleCommand.ACT_SEQUENCE:
        return this.#sequence(Array.isArray(args['steps']) ? args['steps'] : []);
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
      // Elements in closed menus are left out. `query` and `match` still find them.
      omitted: written.omitted,
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
      found = found.filter(holds);
    }
    const limit = 'number' === typeof args['limit'] ? args['limit'] : found.length;
    return { elements: found.slice(0, limit).map((s) => this.#describe(s)), count: found.length };
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
   * Several actions in one command, so a model turn drives more than one step. It stops at the
   * first action that fails, and the failure names the step.
   */
  async #sequence(steps: readonly unknown[]): Promise<unknown> {
    const done: ActResult[] = [];
    for (const [index, step] of steps.entries()) {
      try {
        done.push(await this.#act(record(step)));
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

  async #act(args: Args): Promise<ActResult> {
    const ref = text(args['ref']) ?? '';
    const action = text(args['action']) ?? '';
    const kind = KIND_OF[action];
    if (kind === undefined) {
      throw new Error(
        `the computer-use realm does not have the action ${action}. It has: ${PEER_ACTIONS.join(', ')}.`,
      );
    }
    const target = await this.#resolve(ref);
    const more = record(args['args']);
    const value = text(more['value']);
    const workspace = this.#deps.workspace;
    const filesBefore = workspace?.snapshot();
    const outcome = await this.#deps.driver.act({
      target,
      kind,
      ...(value === undefined ? {} : { value }),
      delivery: Delivery.USER_PATH,
      budgetMs: 'number' === typeof more['settleMs'] ? more['settleMs'] : DEFAULT_SETTLE_MS,
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
    if (workspace !== undefined && filesBefore !== undefined) {
      for (const file of diffSnapshots(filesBefore, workspace.snapshot())) {
        this.#deps.emit(EventType.SIGNAL, {
          name: `${FILE_SIGNAL_PREFIX}${file.kind}`,
          data: { file: basename(file.path), path: file.path, size: file.after?.size ?? 0 },
        });
      }
    }
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
