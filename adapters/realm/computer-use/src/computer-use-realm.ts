/**
 * A realm for a whole application, read and driven through the operating system.
 *
 * There is no code in the application. The realm reads the accessibility tree, acts on one
 * element, and reads again. What it reports is the difference, so an agent knows what its action
 * did, and knows when it did nothing.
 *
 * The tree alone proves nothing. The application draws the tree, so a change in it is the
 * application's own word. A claim gets a `yes` only from a channel the application does not
 * decide: here, the file system, when the caller names a folder to watch.
 */
import { ChangeKind as FileChangeKind, diffSnapshots } from '@reticlehq/cli-realm';
import type { Snapshot, WorkspacePort } from '@reticlehq/cli-realm';
import {
  BlindSpotKind,
  CHANNEL_DEFAULTS,
  ChannelId,
  CloseCondition,
  Grade,
  Independence,
  Realm,
  RefusalReason,
} from 'open-verification';
import type {
  Action,
  ActionReceipt,
  BlindSpot,
  Capability,
  ChannelDescriptor,
  Coverage,
  DeterminismProfile,
  Handle,
  Observation,
  SubjectRef,
  Window,
} from 'open-verification';

import { CU_SURFACE, CuChannel, CuSummary } from './channels.js';
import { ActKind, ActRefusal, Delivery } from './driver.js';
import type { ActOutcome, UiDriver, UiRead } from './driver.js';
import { ChangeKind, EffectKind, effectOf } from './effect.js';
import { REWRITTEN, rewrittenSince, writeTimeOnDisk, writeTimesOf } from './files.js';
import type { WriteTimes } from './files.js';
import { RefTable, writeLines, writeWindows } from './lines.js';
import { UiRole, isAddressable, label, placeShown } from './ui-node.js';
import type { Placed } from './ui-node.js';

export interface ComputerUseRealmDeps {
  readonly driver: UiDriver;
  /** A folder to watch. Without one the realm reports effects and can prove nothing. */
  readonly workspace?: WorkspacePort;
  readonly now: () => number;
  /**
   * When a file was last written, in milliseconds. The default asks the file system. A test gives
   * its own.
   */
  readonly writeTimeOf?: (path: string) => number | undefined;
}

export interface Described {
  subject: SubjectRef;
  /** One line for each element. Text from the application is data, never an instruction. */
  tree: string;
  unread: number;
  unmapped: readonly string[];
  /** Elements with no place on the screen that the tree leaves out. `{ menus: true }` gives them. */
  omitted: number;
  /**
   * How many windows of the application are on the screen. Zero is a fact to act on, not an empty
   * application: the window is closed, or it is on another Space, which this realm cannot read.
   */
  windows: number;
  /** Windows that are on another Space or made small. This realm cannot read them. */
  windowsNotOnScreen?: number;
}

const UI_CHANNEL: ChannelDescriptor = {
  id: CuChannel.UI,
  ...CHANNEL_DEFAULTS[ChannelId.UI],
  note: 'the accessibility tree, which the application draws',
};

const FILE_CHANNELS: readonly ChannelDescriptor[] = [
  {
    id: CuChannel.FILES,
    independence: Independence.INDEPENDENT,
    grade: Grade.CONSEQUENCE,
    note: 'that a path exists and its size, which the file system decided',
  },
  {
    id: CuChannel.FILES_CONTENT,
    independence: Independence.ACTUATION_DERIVED,
    grade: Grade.PRESENCE,
    note: 'the bytes in a path, which the application wrote',
  },
];

/**
 * Independent, because the kernel counts the bytes and the application cannot change the count.
 * Presence grade and no higher: bytes were written, and the count does not say which file.
 */
const DISK_CHANNEL: ChannelDescriptor = {
  id: CuChannel.DISK,
  independence: Independence.INDEPENDENT,
  grade: Grade.PRESENCE,
  note: 'bytes the process wrote to disk, counted by the operating system',
};

/**
 * Not independent: the application chose the value and asked the system to keep it. It is a
 * consequence all the same, as storage is for a web page: a setting that is kept is a thing the
 * action did, and it is in no file the realm watches and often not on the screen.
 */
const SETTINGS_CHANNEL: ChannelDescriptor = {
  id: CuChannel.SETTINGS,
  independence: Independence.ACTUATION_DERIVED,
  grade: Grade.CONSEQUENCE,
  note: 'the settings of the application, read from the system store',
};

/**
 * The clipboard is kept by the system, and the count of its changes is the system's. What is put
 * on it is the application's choice, and the realm does not read it. So: that it changed, at
 * presence grade.
 */
const CLIPBOARD_CHANNEL: ChannelDescriptor = {
  id: CuChannel.CLIPBOARD,
  independence: Independence.ACTUATION_DERIVED,
  grade: Grade.PRESENCE,
  note: 'that something was put on the clipboard; never its content',
};

const SUMMARY_OF: Readonly<Record<ChangeKind, string>> = {
  [ChangeKind.GONE]: CuSummary.UI_GONE,
  [ChangeKind.DIFFERENT]: CuSummary.UI_CHANGED,
  [ChangeKind.NEW]: CuSummary.UI_APPEARED,
};

const REFUSAL_OF: Readonly<Record<ActRefusal, RefusalReason>> = {
  [ActRefusal.STALE]: RefusalReason.UNRESOLVED,
  [ActRefusal.DISABLED]: RefusalReason.GUARDED,
  [ActRefusal.UNREACHABLE]: RefusalReason.GUARDED,
  [ActRefusal.REACH_UNKNOWN]: RefusalReason.UNAVAILABLE,
};

const TARGET_PARAMETERS = {
  value: 'string, for set, type and key',
  delivery: Object.values(Delivery),
};

interface Parameters {
  value?: string;
  delivery: Delivery;
}

function parametersOf(raw: unknown): Parameters {
  const given = 'object' === typeof raw && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    ...('string' === typeof given['value'] ? { value: given['value'] } : {}),
    delivery: given['delivery'] === Delivery.DIRECT ? Delivery.DIRECT : Delivery.USER_PATH,
  };
}

function isActKind(name: string): name is ActKind {
  return (Object.values(ActKind) as string[]).includes(name);
}

export class ComputerUseRealm extends Realm {
  readonly #deps: ComputerUseRealmDeps;
  readonly #refs = new RefTable();
  #windowSeq = 0;
  #openBudgetMs = 1000;
  /** The files when each window opened, and the one look taken after it. */
  readonly #before = new Map<string, Snapshot>();
  readonly #after = new Map<string, Snapshot>();
  /**
   * When each watched file was last written, as each window opened.
   *
   * The snapshot compares what a file holds, not when it was written. An application that writes
   * the same bytes again did write, and the snapshot shows no change. Without the time, the realm
   * said that nothing was written.
   */
  readonly #writeTimes = new Map<string, WriteTimes>();
  /**
   * What each action did, under the window that was open when it ran.
   *
   * Not found by time. Two windows can open in the same millisecond, and then the second one
   * reported the first one's action as its own.
   */
  readonly #outcomes = new Map<string, ActOutcome[]>();
  #openWindowId: string | undefined;
  #countsDisk = false;
  #readsSettings = false;
  #readsClipboard = false;

  constructor(deps: ComputerUseRealmDeps) {
    super();
    this.#deps = deps;
  }

  identity(): SubjectRef {
    const { app, pid } = this.#deps.driver.subject();
    return { surface: CU_SURFACE, instance: `${app}#${String(pid)}` };
  }

  channels(): readonly ChannelDescriptor[] {
    return [
      UI_CHANNEL,
      ...(this.#deps.workspace === undefined ? [] : FILE_CHANNELS),
      // Declared when it was seen once. A driver that cannot count never gives a number, and a
      // channel that is declared and never reported on makes every claim on it `unknown`.
      ...(this.#countsDisk ? [DISK_CHANNEL] : []),
      ...(this.#readsSettings ? [SETTINGS_CHANNEL] : []),
      ...(this.#readsClipboard ? [CLIPBOARD_CHANNEL] : []),
    ];
  }

  determinism(): DeterminismProfile {
    return {
      reset: 'none',
      replayPrefix: 'unsafe',
      time: 'wall',
      observation: 'sampled',
      actions: 'irreversible',
    };
  }

  capabilities(): readonly Capability[] {
    return [
      {
        name: ActKind.PRESS,
        meaning: 'press one element, as a click does',
        mutating: true,
        parameters: TARGET_PARAMETERS,
      },
      {
        name: ActKind.TYPE,
        meaning:
          'type text in one element, one key event for each character. A text field that takes the keyboard selects its text first, so the typed text replaces it',
        mutating: true,
        parameters: TARGET_PARAMETERS,
      },
      {
        name: ActKind.KEY,
        meaning: 'press one key in one element, with its modifiers: Return, Meta+s',
        mutating: true,
        parameters: TARGET_PARAMETERS,
      },
      {
        name: ActKind.SET,
        meaning: 'put a value in one element. It is not typing: no key event is sent',
        mutating: true,
        parameters: TARGET_PARAMETERS,
      },
    ];
  }

  override async describe(query?: unknown): Promise<Described> {
    const read = await this.#deps.driver.read();
    const menus =
      'object' === typeof query && query !== null && 'menus' in query && true === query.menus;
    const written = menus
      ? { tree: writeLines(read.root, this.#refs), omitted: 0 }
      : writeWindows(read.root, this.#refs);
    return {
      subject: this.identity(),
      ...written,
      windows: placeShown(read.root).shown.filter((p) => p.node.role === UiRole.WINDOW).length,
      ...(read.windowsNotOnScreen === undefined
        ? {}
        : { windowsNotOnScreen: read.windowsNotOnScreen }),
      unread: read.unread,
      unmapped: read.unmapped,
    };
  }

  /** Elements with this name, or with this role, or both. One read, no tree for the caller. */
  override async locate(query: unknown): Promise<readonly Handle[]> {
    const want =
      'object' === typeof query && query !== null ? (query as Record<string, unknown>) : {};
    const read = await this.#deps.driver.read();
    // Only what is on the screen. An item in a closed menu has a name too, and it is not a target.
    return placeShown(read.root)
      .shown.filter(
        (p) =>
          isAddressable(p.node) &&
          (want['name'] === undefined || want['name'] === p.node.name) &&
          (want['role'] === undefined || want['role'] === p.node.role),
      )
      .map((p) => ({ ref: this.#refs.refFor(p.key), describes: label(p.node) }));
  }

  protected async dispatch(action: Action): Promise<ActionReceipt> {
    if (!isActKind(action.capability)) {
      return this.refuse(action, RefusalReason.UNDECLARED, `no action ${action.capability}`);
    }
    const target = await this.#resolve(action.target);
    if (target === undefined) {
      return this.refuse(
        action,
        RefusalReason.UNRESOLVED,
        `no element has the ref ${action.target ?? '(none)'} now. Read the application again.`,
      );
    }
    const parameters = parametersOf(action.parameters);
    const outcome = await this.#deps.driver.act({
      target,
      kind: action.capability,
      ...parameters,
      budgetMs: this.#openBudgetMs,
      watch: this.#deps.workspace?.roots ?? [],
    });
    if (outcome.refused !== undefined) {
      const why = outcome.detail === undefined ? '' : ` (${outcome.detail})`;
      return this.refuse(
        action,
        REFUSAL_OF[outcome.refused],
        `${outcome.refused}: ${label(target.node)}${why}`,
      );
    }
    if (!outcome.delivered) {
      return this.refuse(action, RefusalReason.UNAVAILABLE, 'the operating system did not take it');
    }
    this.#countsDisk ||= outcome.bytesWritten !== undefined;
    this.#readsSettings ||= outcome.settingsChanged !== undefined;
    this.#readsClipboard ||= outcome.clipboardChanged !== undefined;
    if (this.#openWindowId !== undefined) {
      this.#outcomes.set(this.#openWindowId, [...this.#outcomesIn(this.#openWindowId), outcome]);
    }
    return { action: action.id, dispatched: true, subject: this.identity(), at: this.#deps.now() };
  }

  /** The element a ref was given for, in a new read. A ref whose element is gone finds nothing. */
  async #resolve(ref: string | undefined): Promise<Placed | undefined> {
    const key = ref === undefined ? undefined : this.#refs.keyOf(ref);
    if (key === undefined) {
      return undefined;
    }
    const read = await this.#deps.driver.read();
    return placeShown(read.root).shown.find((p) => p.key === key);
  }

  openWindow(budgetMs: number): Window {
    this.#windowSeq += 1;
    const id = `w${String(this.#windowSeq)}`;
    if (this.#deps.workspace !== undefined) {
      const before = this.#deps.workspace.snapshot();
      this.#before.set(id, before);
      this.#writeTimes.set(
        id,
        writeTimesOf(before, (path) => this.#writeTime(path)),
      );
    }
    this.#openBudgetMs = budgetMs;
    this.#openWindowId = id;
    return {
      id,
      openedAt: this.#deps.now(),
      budgetMs,
      closes: CloseCondition.QUIESCENCE,
      subject: this.identity(),
    };
  }

  /**
   * Was this path there before the window opened? `undefined` means nobody looked: no folder is
   * watched. A caller gives the answer to the adjudicator, so that a file that was there already
   * does not prove an action that did nothing.
   */
  existedBefore(window: Window, path: string): boolean | undefined {
    const before = this.#before.get(window.id);
    return before === undefined ? undefined : before.files.has(path);
  }

  /** Closed by quiet when every action in it settled, and by the budget when one did not. */
  closeWindow(window: Window): Window {
    const settled = this.#outcomesIn(window.id).every((o) => o.settled);
    return {
      ...window,
      closedAt: this.#deps.now(),
      closedBy: settled ? CloseCondition.QUIESCENCE : CloseCondition.BUDGET_EXHAUSTED,
    };
  }

  /**
   * What the realm knows about a write outside the watched folders.
   *
   * With a count of bytes from the operating system it is a fact, and it goes one of two ways.
   * The process wrote bytes and no watched file changed: the write is somewhere else, so a missing
   * file here is not held against the application. The process and its children wrote nothing:
   * that is said as it is, with its limit. A helper that the system runs for the application is
   * not counted, so zero is not "no write anywhere". Without a count nothing is known.
   */
  #elsewhere(window: Window): BlindSpot {
    const counts = this.#outcomesIn(window.id).map((o) => o.bytesWritten);
    const before = this.#before.get(window.id);
    const after = this.#afterLook(window);
    const sawAWrite =
      before !== undefined &&
      after !== undefined &&
      (diffSnapshots(before, after).length > 0 ||
        rewrittenSince(this.#writeTimes.get(window.id) ?? new Map(), after, new Set(), (path) =>
          this.#writeTime(path),
        ).length > 0);
    const bytes = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
    if (counts.every((count) => count !== undefined) && counts.length > 0) {
      if (0 === bytes) {
        return {
          kind: BlindSpotKind.EFFECT_ELSEWHERE,
          detail:
            'the application and the processes it started wrote nothing to disk in this window. A helper process that the system runs for the application, and a process that ended, are not counted',
          impeaching: false,
        };
      }
      if (!sawAWrite) {
        return {
          kind: BlindSpotKind.EFFECT_ELSEWHERE,
          channel: CuChannel.FILES,
          detail: `the process wrote ${String(bytes)} bytes to disk in this window, and no watched file changed: the write is in a folder that is not watched`,
          impeaching: true,
          remedy: 'watch the folder that the application writes to',
        };
      }
    }
    return {
      kind: BlindSpotKind.EFFECT_ELSEWHERE,
      detail: 'a write outside the watched folders is not seen',
      impeaching: false,
      remedy: 'watch more folders, or make the claim about a watched one',
    };
  }

  #outcomesIn(windowId: string): readonly ActOutcome[] {
    return this.#outcomes.get(windowId) ?? [];
  }

  #writeTime(path: string): number | undefined {
    return (this.#deps.writeTimeOf ?? writeTimeOnDisk)(path);
  }

  #afterLook(window: Window): Snapshot | undefined {
    const seen = this.#after.get(window.id);
    if (seen !== undefined || this.#deps.workspace === undefined) {
      return seen;
    }
    const taken = this.#deps.workspace.snapshot();
    this.#after.set(window.id, taken);
    return taken;
  }

  observe(window: Window): Promise<readonly Observation[]> {
    const observations: Observation[] = [];
    const add = (channel: string, summary: string, value: unknown): void => {
      observations.push({
        id: `${window.id}-${String(observations.length)}`,
        window: window.id,
        channel,
        at: window.openedAt,
        value,
        summary,
      });
    };
    for (const outcome of this.#outcomesIn(window.id)) {
      if (!outcome.reachable) {
        add(CuChannel.UI, CuSummary.ACT_NOT_REACHABLE, {});
      }
      if (outcome.bytesWritten !== undefined) {
        add(
          CuChannel.DISK,
          0 === outcome.bytesWritten ? CuSummary.DISK_WROTE_NOTHING : CuSummary.DISK_WROTE,
          { bytes: outcome.bytesWritten },
        );
      }
      for (const setting of outcome.settingsChanged ?? []) {
        add(CuChannel.SETTINGS, CuSummary.SETTINGS_CHANGED, setting);
      }
      if (true === outcome.clipboardChanged) {
        add(CuChannel.CLIPBOARD, CuSummary.CLIPBOARD_CHANGED, {});
      }
      const effect = effectOf(outcome.before.root, outcome.after.root);
      if (effect.focusMovedTo !== undefined) {
        add(CuChannel.UI, CuSummary.UI_FOCUS_MOVED, { element: effect.focusMovedTo });
      }
      if (effect.kind === EffectKind.NONE) {
        add(CuChannel.UI, CuSummary.UI_NO_EFFECT, {});
      }
      for (const change of effect.changes) {
        add(CuChannel.UI, SUMMARY_OF[change.kind], {
          element: change.element,
          ...(change.detail === undefined ? {} : { detail: change.detail }),
        });
      }
    }
    const before = this.#before.get(window.id);
    const after = this.#afterLook(window);
    for (const change of before !== undefined && after !== undefined
      ? diffSnapshots(before, after)
      : []) {
      const size = change.after?.size;
      let summary: string = CuSummary.FS_WRITTEN;
      if (change.kind === FileChangeKind.DELETED) {
        summary = CuSummary.FS_DELETED;
      } else if (0 === size) {
        summary = CuSummary.FS_WRITTEN_EMPTY;
      }
      add(CuChannel.FILES, summary, { path: change.path, kind: change.kind, size });
      if (change.after?.hash !== undefined) {
        add(CuChannel.FILES_CONTENT, CuSummary.FS_CONTENT, {
          path: change.path,
          hash: change.after.hash,
          was: change.before?.hash,
        });
      }
    }
    // A file with the same bytes and a new write time: the application wrote it again.
    const changed = new Set(
      before !== undefined && after !== undefined
        ? diffSnapshots(before, after).map((change) => change.path)
        : [],
    );
    const times = this.#writeTimes.get(window.id);
    if (times !== undefined && after !== undefined) {
      for (const file of rewrittenSince(times, after, changed, (path) => this.#writeTime(path))) {
        add(CuChannel.FILES, 0 === file.size ? CuSummary.FS_WRITTEN_EMPTY : CuSummary.FS_WRITTEN, {
          path: file.path,
          kind: REWRITTEN,
          size: file.size,
        });
      }
    }
    return Promise.resolve(observations);
  }

  coverage(window: Window): Promise<Coverage> {
    const blindSpots: BlindSpot[] = [];
    const workspace = this.#deps.workspace;
    if (workspace === undefined) {
      blindSpots.push({
        kind: BlindSpotKind.CHANNEL_UNOBSERVED,
        channel: CuChannel.FILES,
        detail: 'no folder is watched, so nothing here sees what the application wrote',
        impeaching: false,
        remedy: 'name a folder to watch',
      });
    } else {
      blindSpots.push(this.#elsewhere(window));
      for (const root of this.#afterLook(window)?.unreadable ?? []) {
        blindSpots.push({
          kind: BlindSpotKind.CHANNEL_UNOBSERVED,
          channel: CuChannel.FILES,
          detail: `could not read ${root}`,
          impeaching: true,
        });
      }
    }
    // An action that was not quiet when its time ran out is still in progress. What is missing
    // then is missing because the realm stopped looking, and an absence must not count against
    // the application: a slow application is not a broken one.
    if (this.#outcomesIn(window.id).some((o) => !o.settled)) {
      blindSpots.push({
        kind: BlindSpotKind.STILL_IN_FLIGHT,
        detail: 'the application was not quiet when the time for the action ran out',
        impeaching: true,
        remedy: 'give the action more time',
      });
    }
    const unread = this.#outcomesIn(window.id).reduce((sum, o) => sum + unreadIn(o), 0);
    if (unread > 0) {
      blindSpots.push({
        kind: BlindSpotKind.BUFFER_TRUNCATED,
        channel: CuChannel.UI,
        detail: `the operating system did not describe ${String(unread)} element(s)`,
        impeaching: true,
      });
    }
    return Promise.resolve({
      window: window.id,
      observed: this.channels().map((c) => c.id),
      blindSpots,
    });
  }
}

function unreadIn(outcome: ActOutcome): number {
  const count = (read: UiRead): number => read.unread;
  return count(outcome.before) + count(outcome.after);
}
