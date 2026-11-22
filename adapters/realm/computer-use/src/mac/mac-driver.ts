/**
 * The macOS driver: it runs the `reticle-ax` helper and turns its answers into the driver port.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RETICLE_CAPTURE_FILE_PREFIX } from '@reticlehq/core';
import { z } from 'zod';

import { ActRefusal, Reach } from '../driver.js';
import type {
  ActOutcome,
  ActRequest,
  CaptureHow,
  Captured,
  ReachAnswer,
  UiDriver,
  UiRead,
  WindowState,
} from '../driver.js';
import { AxNodeSchema, fromAx } from './from-ax.js';
import type { AxNode } from './from-ax.js';
import type { Placed } from '../ui-node.js';

const Command = { TREE: 'tree', ACT: 'act', REACH: 'reach', CAPTURE: 'capture' } as const;
/** The word that asks the helper for the whole display, and not the window only. */
const SCREEN = 'screen';
const HelperError = {
  NOT_TRUSTED: 'not-trusted',
  APP_GONE: 'app-gone',
  SCREEN_LOCKED: 'screen-locked',
  OWN_WINDOW: 'own-window',
} as const;

const ErrorSchema = z.object({ error: z.string() });
const TreeSchema = z.object({
  tree: AxNodeSchema,
  unread: z.number(),
  windowsNotOnScreen: z.number().optional(),
});
const CaptureSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  window: z.array(z.number()).optional(),
  scale: z.number().optional(),
  appWindow: z.array(z.number()).optional(),
});
const ReachSchema = z.object({ reach: z.enum(Reach), detail: z.string().optional() });
const RefusedSchema = z.object({ refused: z.enum(ActRefusal), detail: z.string().optional() });
const ActedSchema = z.object({
  delivered: z.boolean(),
  reachable: z.boolean(),
  settled: z.boolean(),
  before: AxNodeSchema,
  after: AxNodeSchema,
  unreadBefore: z.number(),
  unreadAfter: z.number(),
  appGone: z.boolean().optional(),
  bytesWritten: z.number().optional(),
  clipboardChanged: z.boolean().optional(),
  windowState: z
    .object({
      minimized: z.boolean(),
      fullscreen: z.boolean(),
      frame: z.array(z.number()).length(4).optional(),
      wanted: z.array(z.number()).length(4).optional(),
    })
    .optional(),
  settingsChanged: z
    .array(
      z.object({
        key: z.string(),
        old: z.string(),
        new: z.string(),
        cut: z.boolean().optional(),
      }),
    )
    .optional(),
});

/** The state of an arranged window, with its frame as a tuple when the helper read one. */
function windowStateOf(state: {
  minimized: boolean;
  fullscreen: boolean;
  frame?: number[] | undefined;
  wanted?: number[] | undefined;
}): WindowState {
  const tuple = (
    values: number[] | undefined,
  ): readonly [number, number, number, number] | undefined => {
    const [x, y, width, height] = values ?? [];
    return x === undefined || y === undefined || width === undefined || height === undefined
      ? undefined
      : [x, y, width, height];
  };
  const frame = tuple(state.frame);
  const wanted = tuple(state.wanted);
  return {
    minimized: state.minimized,
    fullscreen: state.fullscreen,
    ...(frame === undefined ? {} : { frame }),
    ...(wanted === undefined ? {} : { wanted }),
  };
}

export type RunHelper = (file: string, args: readonly string[]) => Promise<string>;

const SERVE = 'serve';
const HELPER_EXITED = JSON.stringify({ error: 'the helper process ended' });

/**
 * One helper process for the life of a driver. A command is one line to it, and its answer is one
 * line back.
 *
 * A process for each command took about 70 ms to read a small window, and 5 ms of that was the
 * read: the rest was the start of the process and its first word with the application.
 *
 * Commands go one at a time. The helper answers in order, and an answer has no name on it.
 */
export function servingHelper(prefix: readonly string[] = []): RunHelper {
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffered = '';
  const waiting: ((line: string) => void)[] = [];
  let last: Promise<unknown> = Promise.resolve();

  const start = (file: string): ChildProcessWithoutNullStreams => {
    const started = spawn(file, [...prefix, SERVE]);
    started.stdout.setEncoding('utf8');
    started.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
        waiting.shift()?.(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
      }
    });
    started.on('exit', () => {
      child = undefined;
      buffered = '';
      for (const answer of waiting.splice(0)) {
        answer(HELPER_EXITED);
      }
    });
    return started;
  };

  // The helper keeps the program open while a command waits for its answer, and only then. A
  // program whose one open thing was a helper with no hold on it ended in the middle of a read.
  const hold = (on: boolean): void => {
    if (child === undefined) {
      return;
    }
    for (const part of [child, child.stdin, child.stdout, child.stderr]) {
      if (part instanceof Socket || part === child) {
        if (on) {
          part.ref();
        } else {
          part.unref();
        }
      }
    }
  };

  return (file, args) => {
    const answer = last.then(
      () =>
        new Promise<string>((resolve) => {
          child ??= start(file);
          hold(true);
          waiting.push((line) => {
            hold(waiting.length > 0);
            resolve(line);
          });
          child.stdin.write(`${JSON.stringify(args)}\n`);
        }),
    );
    last = answer;
    return answer;
  };
}

export interface MacDriverInput {
  /** The path of the `reticle-ax` program. */
  helper: string;
  app: string;
  pid: number;
  run?: RunHelper;
}

function toRead(tree: AxNode, unread: number): UiRead {
  const { root, unmapped } = fromAx(tree);
  return { root, unread, unmapped };
}

function refused(reason: ActRefusal, read: UiRead, detail?: string): ActOutcome {
  return {
    refused: reason,
    ...(detail === undefined ? {} : { detail }),
    delivered: false,
    reachable: false,
    settled: true,
    before: read,
    after: read,
  };
}

const NOTHING: UiRead = { root: fromAx({ role: '', children: [] }).root, unread: 0, unmapped: [] };

export class MacDriver implements UiDriver {
  readonly #input: MacDriverInput;
  readonly #run: RunHelper;
  #captures = 0;
  /** The tree as the helper last gave it. An action names its element from this read. */
  #last: AxNode | undefined;

  constructor(input: MacDriverInput) {
    this.#input = input;
    this.#run = input.run ?? servingHelper();
  }

  subject(): { app: string; pid: number } {
    return { app: this.#input.app, pid: this.#input.pid };
  }

  async #ask(args: readonly string[]): Promise<unknown> {
    const answer: unknown = JSON.parse(await this.#run(this.#input.helper, args));
    const failed = ErrorSchema.safeParse(answer);
    if (failed.success && failed.data.error === HelperError.SCREEN_LOCKED) {
      throw new Error(
        'The screen is locked. macOS gives no window of an application while the screen is locked. Unlock the screen, and try again.',
      );
    }
    if (failed.success && failed.data.error === HelperError.OWN_WINDOW) {
      throw new Error(
        'This is the window of Reticle itself. The realm does not read it and does not act on it: Pause in that window is for the person at the machine.',
      );
    }
    if (failed.success && failed.data.error === HelperError.APP_GONE) {
      throw new Error(
        `${this.#input.app} (${String(this.#input.pid)}) is not running. It was closed, or it ended by itself. Open it and join it again.`,
      );
    }
    if (failed.success) {
      throw new Error(
        failed.data.error === HelperError.NOT_TRUSTED
          ? 'reticle-ax has no Accessibility permission. Allow the terminal in System Settings, Privacy & Security, Accessibility.'
          : `reticle-ax: ${failed.data.error}`,
      );
    }
    return answer;
  }

  async read(): Promise<UiRead> {
    const answer = TreeSchema.parse(await this.#ask([Command.TREE, String(this.#input.pid)]));
    this.#last = answer.tree;
    return {
      ...toRead(answer.tree, answer.unread),
      ...(answer.windowsNotOnScreen === undefined
        ? {}
        : { windowsNotOnScreen: answer.windowsNotOnScreen }),
    };
  }

  /** The element as the helper last gave it, at the place of `path`. */
  #rawAt(path: readonly number[]): AxNode | undefined {
    let raw: AxNode | undefined = this.#last;
    for (const index of path) {
      // A child that has "i" is found by it: the helper left some of its siblings out.
      raw = raw?.children.find((child, order) => (child.i ?? order) === index);
    }
    return raw;
  }

  async capture(how?: CaptureHow): Promise<Captured> {
    this.#captures += 1;
    // In the temporary folder and with the prefix the daemon asks for: it reads no other file.
    const path = join(
      tmpdir(),
      `${RETICLE_CAPTURE_FILE_PREFIX}cu-${String(this.#input.pid)}-${String(this.#captures)}.png`,
    );
    const answer = CaptureSchema.safeParse(
      await this.#ask([
        Command.CAPTURE,
        String(this.#input.pid),
        path,
        ...(true === how?.screen ? [SCREEN] : []),
      ]),
    );
    if (!answer.success) {
      return { ok: false, reason: 'the helper gave no picture' };
    }
    if (!answer.data.ok) {
      return { ok: false, reason: answer.data.reason ?? 'the capture failed' };
    }
    const [x = 0, y = 0, width = 0, height = 0] = answer.data.window ?? [];
    const app = answer.data.appWindow;
    return {
      ok: true,
      path,
      window: [x, y, width, height],
      scale: answer.data.scale ?? 1,
      ...(app === undefined
        ? {}
        : { appWindow: [app[0] ?? 0, app[1] ?? 0, app[2] ?? 0, app[3] ?? 0] }),
    };
  }

  async reach(target: Placed): Promise<ReachAnswer> {
    const raw = this.#rawAt(target.path);
    if (raw === undefined) {
      return { reach: Reach.UNKNOWN, detail: 'the element is not in the last read' };
    }
    const answer = await this.#ask([
      Command.REACH,
      String(this.#input.pid),
      target.path.join('.'),
      raw.role,
      raw.title ?? raw.description ?? '',
    ]);
    const known = ReachSchema.safeParse(answer);
    if (!known.success) {
      // A refusal: the element moved or the application did not answer.
      return { reach: Reach.UNKNOWN, detail: 'the element is not where it was' };
    }
    return {
      reach: known.data.reach,
      ...(known.data.detail === undefined ? {} : { detail: known.data.detail }),
    };
  }

  async act(request: ActRequest): Promise<ActOutcome> {
    const raw = this.#rawAt(request.target.path);
    if (raw === undefined) {
      return refused(ActRefusal.STALE, NOTHING);
    }
    const answer = await this.#ask([
      Command.ACT,
      String(this.#input.pid),
      request.target.path.join('.'),
      raw.role,
      raw.title ?? raw.description ?? '',
      request.kind,
      request.value ?? '',
      String(request.budgetMs),
      request.quietMs === undefined
        ? request.delivery
        : `${request.delivery}:${String(request.quietMs)}`,
      ...request.watch,
    ]);
    const no = RefusedSchema.safeParse(answer);
    if (no.success) {
      return refused(no.data.refused, NOTHING, no.data.detail);
    }
    const acted = ActedSchema.parse(answer);
    return {
      delivered: acted.delivered,
      reachable: acted.reachable,
      settled: acted.settled,
      ...(true === acted.appGone ? { appGone: true as const } : {}),
      before: toRead(acted.before, acted.unreadBefore),
      after: toRead(acted.after, acted.unreadAfter),
      ...(acted.bytesWritten === undefined ? {} : { bytesWritten: acted.bytesWritten }),
      ...(acted.clipboardChanged === undefined ? {} : { clipboardChanged: acted.clipboardChanged }),
      ...(acted.windowState === undefined ? {} : { windowState: windowStateOf(acted.windowState) }),
      ...(acted.settingsChanged === undefined
        ? {}
        : {
            settingsChanged: acted.settingsChanged.map(({ cut, ...change }) =>
              true === cut ? { ...change, cut } : change,
            ),
          }),
    };
  }
}
