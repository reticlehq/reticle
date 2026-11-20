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
import { RefTable, writeLines, writeWindows } from './lines.js';
import { UiRole, isAddressable, label, placeShown } from './ui-node.js';
import type { Placed } from './ui-node.js';

export interface ComputerUseRealmDeps {
  readonly driver: UiDriver;
  /** A folder to watch. Without one the realm reports effects and can prove nothing. */
  readonly workspace?: WorkspacePort;
  readonly now: () => number;
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
   * What each action did, under the window that was open when it ran.
   *
   * Not found by time. Two windows can open in the same millisecond, and then the second one
   * reported the first one's action as its own.
   */
  readonly #outcomes = new Map<string, ActOutcome[]>();
  #openWindowId: string | undefined;

  constructor(deps: ComputerUseRealmDeps) {
    super();
    this.#deps = deps;
  }

  identity(): SubjectRef {
    const { app, pid } = this.#deps.driver.subject();
    return { surface: CU_SURFACE, instance: `${app}#${String(pid)}` };
  }

  channels(): readonly ChannelDescriptor[] {
    return [UI_CHANNEL, ...(this.#deps.workspace === undefined ? [] : FILE_CHANNELS)];
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
        meaning: 'type text in one element, one key event for each character',
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
      this.#before.set(id, this.#deps.workspace.snapshot());
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

  /** Closed by quiet when every action in it settled, and by the budget when one did not. */
  closeWindow(window: Window): Window {
    const settled = this.#outcomesIn(window.id).every((o) => o.settled);
    return {
      ...window,
      closedAt: this.#deps.now(),
      closedBy: settled ? CloseCondition.QUIESCENCE : CloseCondition.BUDGET_EXHAUSTED,
    };
  }

  #outcomesIn(windowId: string): readonly ActOutcome[] {
    return this.#outcomes.get(windowId) ?? [];
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
      const effect = effectOf(outcome.before.root, outcome.after.root);
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
      blindSpots.push({
        kind: BlindSpotKind.EFFECT_ELSEWHERE,
        detail: 'a write outside the watched folders is not seen',
        impeaching: false,
        remedy: 'watch more folders, or make the claim about a watched one',
      });
      for (const root of this.#afterLook(window)?.unreadable ?? []) {
        blindSpots.push({
          kind: BlindSpotKind.CHANNEL_UNOBSERVED,
          channel: CuChannel.FILES,
          detail: `could not read ${root}`,
          impeaching: true,
        });
      }
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
