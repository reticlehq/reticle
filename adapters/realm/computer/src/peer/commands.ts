/**
 * Answers the bridge's commands for an application, so the tools an agent already has for a web
 * page (look, act, act and wait, assert) work on a desktop application.
 *
 * It is strict where the browser is generous: a name matches only when it is equal, and a state
 * this realm cannot read is an error, not a guess. A check that cannot be decided must come back
 * as "not known". A wrong `yes` costs more than a missing one.
 */
import { basename } from 'node:path';

import { ChangeKind as FileKind, diffSnapshots } from '@reticlehq/cli-realm';
import type { Snapshot, WorkspacePort } from '@reticlehq/cli-realm';
import {
  ActionType,
  DRAG_TO_REF_ARG,
  ElementState,
  EventType,
  HumanControlKind,
  QueryBy,
  ReticleCommand,
} from '@reticlehq/core';

import { ActKind, ActRefusal, Delivery, PIXELS_CHANGED_SIGNAL, Reach } from '../driver.js';
import type { ActOutcome, UiDriver } from '../driver.js';
import { pixelEffect, sawNothing } from './act-effect.js';
import { ChangeKind, effectOf } from '../effect.js';
import type { Change } from '../effect.js';
import { REWRITTEN, rewrittenSince, writeTimeOnDisk, writeTimesOf } from '../files.js';
import type { WriteTimeOf, WriteTimes } from '../files.js';
import { HudEffect } from '../hud/port.js';
import type { HudPort } from '../hud/port.js';
import { RefTable, writeWindows } from '../lines.js';
import {
  BOX_ROLES,
  DELETE,
  FOREGROUND_ONLY,
  PEER_ACTIONS,
  SELECT_ALL,
  SettleReason,
  TEXT_ROLES,
  VALUE_OF,
  WANTS_CHECKED,
  heldBy,
  movedTo,
  isChecked,
  testidOf,
} from './form.js';
import type { ActResult } from './form.js';
import { READ_STATE, see } from './seen.js';
import { arrangeWindow } from './window.js';
import { refusalOf } from './link-switch.js';
import {
  NO_SCREEN_RECORDING,
  handOf,
  wordsOfPicture,
  wantsPixels,
  pointerPath,
  contentMoved,
  kindFor,
  needsForeground,
  placesOf,
  windowFramesOf,
  windowMoved,
  dragValue,
  pointFor,
  usesPicture,
} from './pointer.js';
import type { Picture } from './pointer.js';
import { WHEEL_AT, scrollBy } from './scroll.js';
import { selectChoice } from './select.js';
import type { Seen } from './seen.js';
import { UiRole, isAddressable, place, quoted } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';

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
  /** When a file was last written. The default asks the file system. A test gives its own. */
  writeTimeOf?: WriteTimeOf;
  /**
   * The quiet time for an action. The peer goes on looking after an action (`sendTreeChanges`), so
   * an action can be called finished sooner than a caller that looks once must wait.
   */
  quietMs?: number;
  /**
   * A known reason why a press can do nothing in this application. The answer to a press with
   * no effect carries it as `note`. An Electron application with its switch off is the case.
   */
  noEffectNote?: string;
  /**
   * False: the realm never brings the application to the front and never uses the real pointer,
   * also when a caller asks. The person who joined the application said so.
   */
  foreground?: boolean;
  /** What the person at the machine sees of the realm. Absent: nothing is shown. */
  hud?: HudPort;
}

/** An application has one screen for the server: it has no address a caller can go to. */
const ROUTE = '/';
/** Room for an effect that comes up to a second late, and then the quiet time after it. */
const DEFAULT_SETTLE_MS = 1500;
/**
 * The quiet time for an action through the peer. It is shorter than the driver's own 500 ms,
 * because the peer goes on looking: a change that comes after the action is sent when it comes.
 */
const PEER_QUIET_MS = 150;
/** The looks after an action that teach nothing: a late effect of the action can be in them. */
const LOOKS_AFTER_ACT = 2;
/** The looks in which a place must change, with no action near, before it "changes by itself". */
const RESTLESS_LOOKS = 2;
/** The places in one parent that must change by themselves before the whole parent does. */
const RESTLESS_PLACES = 3;
/**
 * Said with a press after which the realm saw no effect of any kind. "Dispatched" means that the
 * application took the call, and an application can take it and do nothing with it.
 */
const NOTHING_SEEN_NOTE =
  'The press was sent, and nothing changed: not on the screen, not on disk, not in a setting, not on the clipboard. The control may do nothing here, or the application did not act on the press. Do not take the press for done. Read the window again, and give `until` with the consequence you expect.';

/**
 * The element that a ref named, when its key is gone: an application can change the groups round
 * a control and leave the control where it was. The answer is the one element with the same role,
 * name and identifier at the same place. With no name, two such elements, or another place, there
 * is no answer: the OK of a new dialog is not the OK of the dialog before it.
 */
function sameAtItsPlace(all: readonly Seen[], who: UiNode | undefined): Seen | undefined {
  const was = who?.frame;
  if (who === undefined || was === undefined || 0 === who.name.length) {
    return undefined;
  }
  const same = all.filter((s) => {
    const is = s.node.frame;
    return (
      s.node.role === who.role &&
      s.node.name === who.name &&
      s.node.id === who.id &&
      is !== undefined &&
      was.every((value, at) => Math.abs(value - (is[at] ?? Number.NaN)) <= 1)
    );
  });
  return 1 === same.length ? same[0] : undefined;
}

/** Each check is one question to the operating system. A search this wide is not a check. */
const MAX_REACH_CHECKS = 8;
const Field = { VALUE: 'value', STATES: 'states' } as const;

/**
 * One signal for each file an action changed. The name is `file.` and the kind of change:
 * `file.written`, `file.modified`, `file.deleted`, `file.mode-changed`. A file that was written
 * again with the same bytes is `file.written` too, with `kind: "rewritten"`. The data is the file name,
 * its path and its size.
 */
/** What the agent reads when the person presses "Done" on the HUD at the end of their turn. */
export const HUMAN_DONE =
  'Done: the person finished what you asked for on the HUD. Read the screen again.';

export const FILE_SIGNAL_PREFIX = 'file.';

/**
 * The signal for an action in which the application's process wrote bytes to disk, in any folder.
 * The operating system counts the bytes. No folder has to be watched for it.
 */
export const DISK_WROTE_SIGNAL = 'disk.wrote';

/** The signal for one setting of the application that an action changed: its key and its values. */
export const SETTINGS_CHANGED_SIGNAL = 'settings.changed';

/** The signal for an action that put something on the clipboard. It does not carry the content. */
export const CLIPBOARD_CHANGED_SIGNAL = 'clipboard.changed';

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
  ReticleCommand.CAPTURE,
] as const;

type Args = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}
function record(value: unknown): Args {
  return 'object' === typeof value && value !== null ? (value as Args) : {};
}

export { PEER_ACTIONS };

export class PeerCommands {
  readonly #deps: PeerCommandsDeps;
  readonly #refs = new RefTable();
  /** The watched folders at the last look. Absent before the first one. */
  #files: Snapshot | undefined;
  /** When each watched file was last written, at the last look. */
  #fileTimes: WriteTimes | undefined;
  /** The tree at the last look, to say what changed since. */
  #tree: UiNode | undefined;
  /** Actions in progress. An action says its own changes, so the look between actions waits. */
  #acting = 0;
  #looking = false;
  /** Where the last picture was taken, and its pixels for each point of the screen. */
  #picture: Picture | undefined;
  /** Looks since the last action. The first ones can hold a late effect of that action. */
  #looksSinceAct = 0;
  /**
   * How many looks, with no action near, saw each place change. A place that changed in two of
   * them changes by itself: a clock, a tip that rotates. A change there during an action is not
   * counted as the effect of the action. A place is one element: its parent, its role and its
   * corner. It was the whole parent, and a clock that lies in the window made every effect in
   * that window "changed by itself".
   */
  readonly #restless = new Map<string, number>();
  /**
   * The places in each parent that changed with no action near. A parent with several of them
   * changes by itself as a whole: a list that gets new rows, each at a new place.
   */
  readonly #restlessIn = new Map<string, Set<string>>();
  constructor(deps: PeerCommandsDeps) {
    this.#deps = deps;
    deps.hud?.app(deps.driver.subject().app);
    // The person ends their turn on the HUD: the agent gets it as their message.
    deps.hud?.onDone?.(() => {
      deps.emit(EventType.HUMAN_CONTROL, { kind: HumanControlKind.MESSAGE, text: HUMAN_DONE });
    });
    // The first look. A file that is there now is not a change.
    this.sendFileChanges();
  }

  /**
   * Sends what changed in the tree since the last look, when no action is in progress.
   *
   * An action sends its own changes before it answers. An application also changes after that: a
   * second step of an effect, a save that ends late. With no look between actions those changes
   * were sent by nobody, and a caller that waited for them had only its own questions to go on.
   * The peer calls this on a timer.
   */
  async sendTreeChanges(): Promise<void> {
    if (this.#acting > 0 || this.#looking) {
      return;
    }
    this.#looking = true;
    try {
      const read = await this.#deps.driver.read();
      // An action that began while the read was out says its own changes from its own reads.
      if (0 === this.#acting) {
        if (this.#tree !== undefined) {
          const { changes } = effectOf(this.#tree, read.root);
          for (const change of changes) {
            this.#send(change);
          }
          this.#looksSinceAct += 1;
          if (this.#looksSinceAct > LOOKS_AFTER_ACT) {
            for (const change of changes) {
              this.#restlessIn.set(
                change.within,
                (this.#restlessIn.get(change.within) ?? new Set()).add(change.at),
              );
            }
            for (const place of new Set(changes.map((change) => change.at))) {
              this.#restless.set(place, (this.#restless.get(place) ?? 0) + 1);
            }
          }
        }
        this.#tree = read.root;
      }
    } finally {
      this.#looking = false;
    }
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
    const timeOf = this.#deps.writeTimeOf ?? writeTimeOnDisk;
    const now = workspace.snapshot();
    const changes = diffSnapshots(this.#files ?? now, now);
    for (const file of changes) {
      this.#deps.emit(EventType.SIGNAL, {
        name: `${FILE_SIGNAL_PREFIX}${file.kind}`,
        data: { file: basename(file.path), path: file.path, size: file.after?.size ?? 0 },
      });
    }
    // The same bytes, written again: the snapshot shows no change, and the write time does.
    const changed = new Set(changes.map((file) => file.path));
    for (const file of rewrittenSince(this.#fileTimes ?? new Map(), now, changed, timeOf)) {
      this.#deps.emit(EventType.SIGNAL, {
        // The same name as a first write: a claim that the file was written holds for it. The
        // data says that the bytes are the ones that were there.
        name: `${FILE_SIGNAL_PREFIX}${FileKind.WRITTEN}`,
        data: { file: basename(file.path), path: file.path, size: file.size, kind: REWRITTEN },
      });
    }
    this.#files = now;
    this.#fileTimes = writeTimesOf(now, timeOf);
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
      case ReticleCommand.CAPTURE:
        return this.#capture(args);
      case ReticleCommand.PRESENTER:
        return this.#presenter(args);
      case ReticleCommand.NARRATE:
        // What the agent did in a page, in the log the person reads while computer use is live.
        this.#deps.hud?.act(text(args['text']) ?? '');
        return { ok: true };
      case ReticleCommand.IMPACT:
      case ReticleCommand.FLOW_PROGRESS:
      case ReticleCommand.PLAN:
        // Reports that a page HUD draws. The desktop HUD has no place for them.
        return { ok: true };
      default:
        throw new Error(`the computer realm does not answer ${name}`);
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
      ref: this.#refs.refFor(seen.key, seen.node),
      role: seen.node.role,
      name: seen.node.name,
      ...(seen.node.value === undefined ? {} : { value: seen.node.value }),
      ...(seen.node.id === undefined ? {} : { testid: seen.node.id }),
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
    const id = by === QueryBy.TESTID ? value : text(query['testid']);
    if (role === undefined && name === undefined && wanted === undefined && id === undefined) {
      throw new Error(
        'the computer realm finds an element by role, name, text or test id. This query has none of them.',
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
        (id === undefined || id === s.node.id) &&
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
        throw new Error(`the state ${state} is not read by the computer realm`);
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
        `${String(found.length)} elements match. The computer realm checks each one for a window on top, and it checks ${String(MAX_REACH_CHECKS)} at most. Name one element.`,
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
    const all = see(read.root);
    const seen =
      (key === undefined ? undefined : all.find((s) => s.key === key)) ??
      sameAtItsPlace(all, this.#refs.whoOf(ref));
    if (seen === undefined) {
      throw new Error(`ref '${ref}' no longer resolves to an element`);
    }
    if (seen.key !== key) {
      // The application changed the tree round the element, and the element stayed.
      this.#refs.move(ref, seen.key);
    }
    return seen;
  }

  async #inspect(ref: string): Promise<unknown> {
    const seen = await this.#resolve(ref);
    const frame = seen.node.frame;
    return {
      ...this.#describe(seen),
      // What a hover gives a person. The realm has no hover, and it does not need one for this.
      ...(seen.node.help === undefined ? {} : { help: seen.node.help }),
      ...(frame === undefined
        ? {}
        : { box: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] } }),
    };
  }

  /**
   * A picture of the window, for an application that gives few elements. The place and the scale
   * of the picture are kept: a click at a point of the picture needs them.
   */
  /** The agent's `yield`: the HUD shows whose turn it is, and the question when it asks. */
  #presenter(args: Args): Promise<unknown> {
    const state = text(args['state']);
    if (state !== undefined) {
      const tone = text(args['tone']);
      const words = text(args['text']);
      this.#deps.hud?.turn?.({
        state,
        ...(tone === undefined ? {} : { tone }),
        ...(words === undefined ? {} : { text: words }),
      });
    }
    return Promise.resolve({ ok: true });
  }

  async #capture(args: Args): Promise<unknown> {
    const screen = true === args['screen'];
    const taken = await this.#deps.driver.capture?.(screen ? { screen } : undefined);
    if (taken === undefined) {
      return { ok: false, reason: 'this realm takes no picture on this system' };
    }
    if (!taken.ok) {
      return {
        ok: false,
        reason:
          NO_SCREEN_RECORDING === taken.reason
            ? 'The terminal has no Screen Recording permission. Open System Settings, Privacy & Security, Screen Recording, and switch on the terminal that runs reticle-computer.'
            : taken.reason,
      };
    }
    const shown = await this.#deps.driver.read();
    this.#picture = {
      window: taken.window,
      scale: taken.scale,
      appWindow: taken.appWindow ?? taken.window,
      places: placesOf(shown.root),
      // A picture of the whole screen holds every window: a point can be in any of them.
      ...(screen ? { windows: windowFramesOf(shown.root) } : {}),
    };
    const words = wordsOfPicture(await this.#deps.driver.texts?.(taken.path));
    return { ok: true, path: taken.path, ...(screen ? { screen } : {}), ...words };
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
  ): Promise<{ outcome: ActOutcome; changes: Change[]; byItself: number; offScreen: number }> {
    const workspace = this.#deps.workspace;
    const hud = this.#deps.hud;
    if (true === hud?.stopped()) {
      throw new Error(
        'the person at the machine stopped Reticle in its window. The realm does no more actions on this application. Tell them what you were about to do.',
      );
    }
    if (true === hud?.paused()) {
      throw new Error(
        'the person at the machine paused Reticle in its window. No action is done while it is paused. Tell them what you were about to do, and wait.',
      );
    }
    // The pointer goes where the action goes, and for a drag on to where it ends. See pointerPath.
    const path = pointerPath(kind, value, target.node.frame);
    if (path.start !== undefined) {
      await hud?.move(...path.start);
    }
    if (target.windowFrame !== undefined) {
      hud?.glow(target.windowFrame);
    }
    hud?.act(`${kind} ${target.node.role} "${target.node.name}"`);
    // What changed before this action is not its effect: say it first, on its own.
    this.sendFileChanges();
    this.#acting += 1;
    let outcome: ActOutcome;
    try {
      outcome = await this.#deps.driver.act({
        target,
        kind,
        ...(value === undefined ? {} : { value }),
        ...how,
        quietMs: this.#deps.quietMs ?? PEER_QUIET_MS,
        watch: workspace?.roots ?? [],
      });
      if (outcome.refused === undefined) {
        this.#tree = outcome.after.root;
      }
      this.#looksSinceAct = 0;
      if (outcome.refused !== undefined || !outcome.delivered) {
        hud?.effect(`refused: ${outcome.refused ?? 'not taken'}`, HudEffect.REFUSED);
      } else if (path.end !== undefined) {
        await hud?.move(...path.end);
      }
    } finally {
      this.#acting -= 1;
    }
    if (outcome.refused === ActRefusal.STALE) {
      throw new Error(`ref '${ref}' no longer resolves to an element`);
    }
    if (outcome.refused === ActRefusal.UNREACHABLE) {
      throw new Error(
        `a person cannot reach ${target.node.role} "${target.node.name}": ${outcome.detail ?? 'another view or window'} is over it.`,
      );
    }
    if (true === outcome.appGone) {
      throw new Error(
        `${this.#deps.driver.subject().app} ended while the action on ${target.node.role} "${target.node.name}" ran: it quit, or it crashed. The action can be the cause. Do not send it again before you know.`,
      );
    }
    if (outcome.refused === ActRefusal.NO_KEYBOARD) {
      throw new Error(
        `${this.#deps.driver.subject().app} did not take the keyboard, so no real key was sent: a real key goes to whatever application has the keyboard. Send the keys without the foreground, or bring the application to the front first with the action ${ActionType.FOCUS}.`,
      );
    }
    if (outcome.refused === ActRefusal.PERSON_ACTIVE) {
      throw new Error(
        `the person at the machine is using the keyboard or the pointer, so the realm did not take the pointer for ${target.node.role} "${target.node.name}". It waited five seconds. Try again when they are not typing, or do the step without the foreground.`,
      );
    }
    if (outcome.refused === ActRefusal.NO_REAL_INPUT) {
      throw new Error(
        `no real pointer or key was sent: ${outcome.detail ?? 'the desktop takes none from a program'}. Do the step without args.foreground, through the accessibility interface, or log in to an X session.`,
      );
    }
    if (outcome.refused === ActRefusal.NEEDS_FOREGROUND) {
      throw new Error(needsForeground(kind, this.#deps.driver.subject().app));
    }
    if (outcome.refused === ActRefusal.REACH_UNKNOWN) {
      throw new Error(
        `could not tell if a person can reach ${target.node.role} "${target.node.name}": ${outcome.detail ?? 'the operating system did not answer'}. The menu bar of an application is on the screen only when the application is in front. Bring ${this.#deps.driver.subject().app} to the front, or use a control in its window.`,
      );
    }
    // The application has no menu to give by name for this element. The real button can try.
    if (kind === ActKind.MENU && outcome.refused === undefined && !outcome.delivered) {
      throw new Error(needsForeground('a right-click here', this.#deps.driver.subject().app));
    }
    if (outcome.refused !== undefined || !outcome.delivered) {
      throw new Error(
        `${target.node.role} "${target.node.name}" did not take the action: ${outcome.refused ?? 'the operating system refused it'}.`,
      );
    }
    const restless = new Set([
      ...[...this.#restless].filter(([, looks]) => looks >= RESTLESS_LOOKS).map(([at]) => at),
      ...[...this.#restlessIn]
        .filter(([, places]) => places.size >= RESTLESS_PLACES)
        .map(([parent]) => parent),
    ]);
    const effect = effectOf(outcome.before.root, outcome.after.root, restless);
    const all = effect.changes;
    // Every change is sent: it did happen. Only the count of what the action did leaves out the
    // places that change by themselves.
    for (const change of all) {
      this.#send(change);
    }
    const changes = all.filter((change) => change.ambient === undefined);
    hud?.effect(
      0 === changes.length ? 'no change' : `${String(changes.length)} change(s)`,
      0 === changes.length ? HudEffect.NONE : HudEffect.OK,
    );
    // The bytes that the process wrote to disk, when the driver counts them. A signal only when
    // there were some: a claim with `count: 0` then says "the application wrote nothing".
    // A setting that the action changed. It is often not on the screen and in no watched file.
    for (const setting of outcome.settingsChanged ?? []) {
      this.#deps.emit(EventType.SIGNAL, {
        name: SETTINGS_CHANGED_SIGNAL,
        data: {
          key: setting.key,
          old: setting.old,
          value: setting.new,
          ...(true === setting.cut ? { cut: true } : {}),
        },
      });
    }
    if (true === outcome.clipboardChanged) {
      this.#deps.emit(EventType.SIGNAL, { name: CLIPBOARD_CHANGED_SIGNAL, data: {} });
    }
    if ((outcome.pixels?.changed ?? 0) > 0) {
      this.#deps.emit(EventType.SIGNAL, { name: PIXELS_CHANGED_SIGNAL, data: outcome.pixels });
    }
    if (outcome.bytesWritten !== undefined && outcome.bytesWritten > 0) {
      this.#deps.emit(EventType.SIGNAL, {
        name: DISK_WROTE_SIGNAL,
        data: { bytes: outcome.bytesWritten },
      });
    }
    this.sendFileChanges();
    return { outcome, changes, byItself: all.length - changes.length, offScreen: effect.offScreen };
  }

  #scroll(args: Args): Promise<Record<string, unknown>> {
    return scrollBy(
      {
        driver: this.#deps.driver,
        refs: this.#refs,
        drive: (target, at, kind, value, how) => this.#drive(target, at, kind, value, how),
      },
      args,
    );
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

  /**
   * The point a drag ends at, as "x,y" on the screen: the middle of the element with the ref
   * `to.ref`, or the point `to.x`, `to.y`.
   */
  /** The frame of the element a drag goes onto (`args.toRef`), or absent when none is named. */
  async #ontoFrame(more: Args): Promise<readonly [number, number, number, number] | undefined> {
    const onto = text(more[DRAG_TO_REF_ARG]);
    if (onto === undefined) {
      return undefined;
    }
    const frame = (await this.#resolve(onto)).node.frame;
    if (frame === undefined) {
      throw new Error(`the element ${onto} has no place on the screen to drag to.`);
    }
    return frame;
  }

  async #act(args: Args, allowed?: readonly string[]): Promise<ActResult> {
    const ref = text(args['ref']) ?? '';
    const action = text(args['action']) ?? '';
    if (action === ActionType.SCROLL) {
      // The same scroll as the `scroll` command, with the answer in the shape of an action.
      const target = await this.#resolve(ref);
      const given = record(args['args']);
      const at = pointFor(this.#picture, given, ActKind.WHEEL, undefined);
      const moved = await this.#scroll({
        ...given,
        ref,
        ...(at === undefined ? {} : { [WHEEL_AT]: at }),
      });
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
    if (action === ActionType.WINDOW) {
      return arrangeWindow(
        { drive: (target, at, kind, value, how) => this.#drive(target, at, kind, value, how) },
        await this.#resolve(ref),
        ref,
        record(args['args']),
      );
    }
    if (action === ActionType.SELECT) {
      return selectChoice(
        {
          driver: this.#deps.driver,
          refs: this.#refs,
          drive: (target, at, kind, value, how) => this.#drive(target, at, kind, value, how),
          act: (step, limit) => this.#act(step, limit),
        },
        ref,
        record(args['args']),
        allowed,
      );
    }
    const more = record(args['args']);
    const foreground = true === more['foreground'];
    const kind = kindFor(action, more, foreground);
    if (kind === undefined) {
      throw new Error(
        `the computer realm does not have the action ${action}. It has: ${PEER_ACTIONS.join(', ')}.`,
      );
    }
    let target = await this.#resolve(ref);
    const refused = refusalOf(target, action, more, allowed);
    if (refused !== undefined) {
      throw new Error(refused);
    }
    const modifiers = Array.isArray(more['modifiers']) ? more['modifiers'].map(String) : [];
    const key = text(more['text']);
    if (kind === ActKind.KEY && key === undefined && VALUE_OF[action] === undefined) {
      throw new Error(
        `${action} needs the key in args.text, as the page realm takes it: { text: "Escape" }, or { text: "r", modifiers: ["Alt", "Shift"] }.`,
      );
    }
    // `fill` gives `value`. `type` gives `text`. `press` gives the key in `text`, with modifiers.
    const given =
      kind === ActKind.KEY && key !== undefined
        ? [...modifiers, key].join('+')
        : (text(more['value']) ?? key);
    if (FOREGROUND_ONLY.has(kind) && !foreground) {
      throw new Error(needsForeground(action, this.#deps.driver.subject().app));
    }
    if (foreground && false === this.#deps.foreground) {
      throw new Error(
        `this session was joined with --background-only: the realm does not take the pointer or bring ${this.#deps.driver.subject().app} to the front.`,
      );
    }
    const at =
      kind === ActKind.DRAG ? undefined : pointFor(this.#picture, more, kind, target.node.frame);
    const picture = usesPicture(more);
    if (picture && windowMoved(this.#picture, target.windowFrame)) {
      throw new Error(
        `the window of ${this.#deps.driver.subject().app} moved or changed its size after the picture was taken, so the point of the picture is now on something else. Take a new picture with reticle_screenshot, and give the point of that one.`,
      );
    }
    if (picture) {
      const now = placesOf((await this.#deps.driver.read()).root);
      if (contentMoved(this.#picture?.places, now)) {
        throw new Error(
          `the content of the window of ${this.#deps.driver.subject().app} moved after the picture was taken (it scrolled, or a part came in above), so the point of the picture is now on something else. Take a new picture with reticle_screenshot, and give the point of that one.`,
        );
      }
    }
    const base =
      kind === ActKind.DRAG
        ? dragValue(this.#picture, more, target.node.frame, await this.#ontoFrame(more))
        : (at ?? VALUE_OF[action] ?? given);
    const hand = handOf(kind, more, wantsPixels(target.node.role, more));
    const value = '' === hand ? base : `${base ?? ''}${hand}`;
    const wanted = WANTS_CHECKED[action];
    if (wanted !== undefined) {
      if (!BOX_ROLES.has(target.node.role)) {
        throw new Error(
          `${action} is for a checkbox or a radio button. ${target.node.role} "${target.node.name}" is not one. Use ${ActionType.CLICK}.`,
        );
      }
      // Nothing is sent to a box that is in the state already: a press would turn it over.
      if (isChecked(target.node) === wanted) {
        return {
          ok: true,
          ref,
          action,
          dispatched: false,
          settled: true,
          settleReason: null,
          effect: { alreadyAtValue: true, dispatched: false, targetMatched: true },
          role: target.node.role,
          name: target.node.name,
        };
      }
    }
    const how = {
      delivery: foreground ? Delivery.FOREGROUND : Delivery.USER_PATH,
      budgetMs: 'number' === typeof more['settleMs'] ? more['settleMs'] : DEFAULT_SETTLE_MS,
    };
    // True when the field took a new value and the application moved it in the tree.
    let valueMoved = false;
    let driven = await this.#drive(target, ref, kind, value, how);
    if (kind === ActKind.SET && value !== undefined && TEXT_ROLES.has(target.node.role)) {
      // A field in a web view answers "done" to a value set from outside, and keeps its old
      // value. The field then gets the keys, as from a person: all of its text selected first,
      // so that the new text replaces it.
      // The application can move the field in its tree as it takes the value. The ref then goes
      // with the field, and the value is read where the field is now.
      const moved = movedTo(driven.outcome, target, value);
      if (moved !== undefined) {
        valueMoved = moved.node.value !== target.node.value;
        this.#refs.move(ref, moved.key);
        target = { ...target, ...moved };
      }
      const first = heldBy(driven.outcome, target.key);
      if (first !== value) {
        if ('' !== first) {
          await this.#drive(target, ref, ActKind.KEY, SELECT_ALL, how);
        }
        driven =
          '' === value
            ? await this.#drive(target, ref, ActKind.KEY, DELETE, how)
            : await this.#drive(target, ref, ActKind.TYPE, value, how);
      }
      const held = heldBy(driven.outcome, target.key);
      if (held !== value) {
        throw new Error(
          `${target.node.role} "${target.node.name}" did not take the value: it holds ${quoted(held)}, not ${quoted(value)}. The realm set the value, then typed it.`,
        );
      }
    }
    const { outcome, changes, byItself, offScreen } = driven;
    if (wanted !== undefined) {
      const now = place(outcome.after.root).find((p) => p.key === target.key)?.node;
      if (now === undefined || isChecked(now) !== wanted) {
        throw new Error(
          `${target.node.role} "${target.node.name}" is still ${wanted ? 'not checked' : 'checked'} after the press.`,
        );
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
        valueChanged: valueMoved || changes.some((c) => c.value !== undefined),
        // Every change in the application, not only those inside the target.
        domMutatedWithin: changes.length,
        // Changes in a place that changes with no action. The action may not be their cause.
        ...(byItself > 0 ? { changedByItself: byItself } : {}),
        // Changes to elements that are not on the screen. They are not in the count above.
        ...(offScreen > 0 ? { changedOffScreen: offScreen } : {}),
        ...pixelEffect(outcome),
        ...(kind === ActKind.PRESS && sawNothing(outcome, changes.length + byItself + offScreen)
          ? { note: this.#deps.noEffectNote ?? NOTHING_SEEN_NOTE }
          : {}),
        occluded: !outcome.reachable,
      },
      role: target.node.role,
      name: target.node.name,
      ...testidOf(target, outcome.before.root),
    };
  }
}
