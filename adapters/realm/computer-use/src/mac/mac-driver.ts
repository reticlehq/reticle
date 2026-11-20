/**
 * The macOS driver: it runs the `reticle-ax` helper and turns its answers into the driver port.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { ActRefusal } from '../driver.js';
import type { ActOutcome, ActRequest, UiDriver, UiRead } from '../driver.js';
import { AxNodeSchema, fromAx } from './from-ax.js';
import type { AxNode } from './from-ax.js';

const Command = { TREE: 'tree', ACT: 'act' } as const;
const HelperError = { NOT_TRUSTED: 'not-trusted' } as const;

const ErrorSchema = z.object({ error: z.string() });
const TreeSchema = z.object({ tree: AxNodeSchema, unread: z.number() });
const RefusedSchema = z.object({ refused: z.enum(ActRefusal), detail: z.string().optional() });
const ActedSchema = z.object({
  delivered: z.boolean(),
  reachable: z.boolean(),
  settled: z.boolean(),
  before: AxNodeSchema,
  after: AxNodeSchema,
  unreadBefore: z.number(),
  unreadAfter: z.number(),
});

export type RunHelper = (file: string, args: readonly string[]) => Promise<string>;

const runProcess: RunHelper = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, [...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

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
  /** The tree as the helper last gave it. An action names its element from this read. */
  #last: AxNode | undefined;

  constructor(input: MacDriverInput) {
    this.#input = input;
    this.#run = input.run ?? runProcess;
  }

  subject(): { app: string; pid: number } {
    return { app: this.#input.app, pid: this.#input.pid };
  }

  async #ask(args: readonly string[]): Promise<unknown> {
    const answer: unknown = JSON.parse(await this.#run(this.#input.helper, args));
    const failed = ErrorSchema.safeParse(answer);
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
    return toRead(answer.tree, answer.unread);
  }

  async act(request: ActRequest): Promise<ActOutcome> {
    let raw: AxNode | undefined = this.#last;
    for (const index of request.target.path) {
      raw = raw?.children[index];
    }
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
      request.delivery,
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
      before: toRead(acted.before, acted.unreadBefore),
      after: toRead(acted.after, acted.unreadAfter),
    };
  }
}
