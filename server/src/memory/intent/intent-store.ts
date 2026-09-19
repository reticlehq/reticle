import {
  bindIntent,
  declareIntent,
  dischargeIntent,
  emptyIntentFile,
  openIntents,
  parseIntentFile,
  upsertIntent,
  type Intent,
  type IntentFile,
  type IntentSurface,
} from '@reticlehq/core/artifacts';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { withFileLock } from '@/memory/project/file-lock.js';
import { parseDeclarations } from './intent-input.js';
import type { Clock } from '@/machine/clock.js';

/**
 * The intent ledger on disk — `.reticle/intent.json`, git-checked and meant to be read in review.
 *
 * Git-checked deliberately. The one real defence against an agent quietly narrowing what it meant to
 * match what it can already prove is that a human sees the narrowing in a diff, and that only works
 * if the file lives with the code and travels with the PR. It is also why the writes are byte-stable:
 * a ledger that churns on every run is one whose diffs nobody reads.
 *
 * Every operation goes through the same file lock the other stores use, because two sessions driving
 * one project is ordinary and a lost declaration would be silent.
 */

const JSON_INDENT = 2;

export class IntentStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #clock: Clock;

  constructor(fs: FileSystemPort, root: string, clock: Clock) {
    this.#fs = fs;
    this.#root = root;
    this.#clock = clock;
  }

  #path(): string {
    return reticleDirPaths(this.#root).intent;
  }

  /**
   * Load the ledger, failing soft to empty.
   *
   * This is a git-checked file an agent can write and a human can hand-merge, so a malformed one is
   * genuinely reachable — a conflict marker left in place is the obvious case. Throwing here would
   * take down the verdict that was only asking what was still open, which trades a small problem for
   * a large one.
   */
  async #load(): Promise<IntentFile> {
    try {
      const raw = await this.#fs.readFile(this.#path());
      return parseIntentFile(JSON.parse(raw) as unknown);
    } catch {
      return emptyIntentFile();
    }
  }

  /** Byte-stable: 2-space indent, one trailing newline. An unchanged ledger produces no diff. */
  async #save(file: IntentFile): Promise<void> {
    await this.#fs.mkdir(reticleDirPaths(this.#root).root);
    await this.#fs.writeFile(this.#path(), `${JSON.stringify(file, null, JSON_INDENT)}\n`);
  }

  /** Every intent, in declaration order. */
  async read(): Promise<Intent[]> {
    return Object.values((await this.#load()).intents);
  }

  /** Everything not yet proved — what an agent asking "am I done?" still owes. */
  async open(): Promise<Intent[]> {
    return openIntents(await this.#load());
  }

  /**
   * Declare one or more intents.
   *
   * Batched because the marginal cost of the whole mechanism has to stay at one call per feature; an
   * agent that must make five calls to declare five things will make none.
   *
   * `entries` is `unknown` rather than a declaration array, and that is the fix for #994 rather than
   * a looseness. One of the four callers is a tool argument that nothing upstream shape-checks — a
   * static parameter type there is the CALLER'S claim, and the claim was wrong: `surface` arrived as
   * the string `/authorize` and was written. Refused here, before the lock, so no path reaches a
   * write with input the reader could not parse back.
   */
  async declare(entries: unknown): Promise<Intent[]> {
    const declarations = parseDeclarations(entries);
    if (0 === declarations.length) return [];
    return withFileLock(this.#path(), async () => {
      let file = await this.#load();
      const now = this.#clock.now();
      const declared: Intent[] = [];
      for (const entry of declarations) {
        const intent = declareIntent({
          id: entry.id,
          statement: entry.statement,
          now,
          ...(entry.surface === undefined ? {} : { surface: entry.surface }),
        });
        file = upsertIntent(file, intent);
        const stored = file.intents[intent.id];
        if (stored !== undefined) declared.push(stored);
      }
      await this.#save(file);
      return declared;
    });
  }

  /**
   * File a record under where it turned out to be about.
   *
   * Separate from `declare` because the two happen at different MOMENTS and know different things.
   * An inline intent is declared BEFORE the action — deliberately, so a verdict can see it open —
   * and at that instant the agent is still on the page it is leaving. The route that describes what
   * the intent is ABOUT only exists after the consequence lands.
   *
   * Write-once: an existing surface is never overwritten. A record placed by an agent that named its
   * own subject must not be re-filed by a later run that happened to be somewhere else.
   */
  async place(id: string, surface: IntentSurface): Promise<boolean> {
    return withFileLock(this.#path(), async () => {
      const file = await this.#load();
      const existing = file.intents[id];
      if (existing === undefined || existing.surface !== undefined) return false;
      await this.#save(upsertIntent(file, { ...existing, surface }));
      return true;
    });
  }

  /** Attach the predicate that would prove an intent. False when the id names nothing. */
  async bind(id: string, binding: unknown): Promise<boolean> {
    return withFileLock(this.#path(), async () => {
      const file = await this.#load();
      const existing = file.intents[id];
      if (existing === undefined) return false;
      await this.#save(upsertIntent(file, bindIntent(existing, binding)));
      return true;
    });
  }

  /**
   * Record that a verdict proved an intent.
   *
   * False rather than a throw on an unknown or unbound id: discharge runs off the back of a verdict,
   * and must never be the reason one fails to return.
   */
  async discharge(
    id: string,
    proof: { verdictId: string; grade: string; at: number },
  ): Promise<boolean> {
    return withFileLock(this.#path(), async () => {
      const file = await this.#load();
      const existing = file.intents[id];
      if (existing === undefined) return false;
      const proved = dischargeIntent(existing, proof);
      if (proved === existing) return false;
      await this.#save(upsertIntent(file, proved));
      return true;
    });
  }
}
