/**
 * Ranking and shaping what the project knows.
 *
 * The network half is exercised by the tool's own test and by driving it; these are the decisions
 * that would otherwise only be visible in a live run — which is where an ordering bug hides longest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import {
  rankKnown,
  readProjectMemory,
  MemoryUnavailable,
  type KnownThing,
} from './project-memory.js';

const thing = (statement: string, status: string): KnownThing => ({
  statement,
  status,
  flowName: null,
  sourceFile: null,
  subject: 'checkout',
});

describe('what an agent reads first', () => {
  it('puts PROVED statements ahead of the rest', () => {
    // An agent is about to ACT on this. A statement a verdict established outranks one somebody
    // merely wrote down, and the cap means the tail may never be read at all.
    const ranked = rankKnown([thing('a', 'agreed'), thing('b', 'proved'), thing('c', 'proposed')]);
    expect(ranked.map((t) => t.statement)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the original order within each group, so the same call twice reads the same', () => {
    // An unstable list reads as the corpus churning when nothing has changed.
    const ranked = rankKnown([thing('a', 'proved'), thing('b', 'proved'), thing('c', 'agreed')]);
    expect(ranked.map((t) => t.statement)).toEqual(['a', 'b', 'c']);
  });

  it('loses nothing — ranking reorders, it does not filter', () => {
    const input = [thing('a', 'stale'), thing('b', 'proved'), thing('c', 'agreed')];
    expect(rankKnown(input)).toHaveLength(input.length);
  });

  it('handles a corpus with nothing proved yet', () => {
    const ranked = rankKnown([thing('a', 'agreed'), thing('b', 'proposed')]);
    expect(ranked.map((t) => t.statement)).toEqual(['a', 'b']);
  });

  it('is empty for an empty corpus rather than throwing', () => {
    expect(rankKnown([])).toEqual([]);
  });
});

const CLOUD = 'https://cloud.test';
const APP_RETICLE = join('/repo/apps/web', ReticleDir.ROOT);
const HOME = '/home/u';
const LINKED = 'repo-b';
/** Another project in the SAME workspace — the one this read must never be answered with. */
const SIBLING = 'repo-a';

/** A linked project on disk: the binding here, the secret in the user's own credential store. */
function linked(projectId = LINKED) {
  const { fs, written } = createMemoryFs();
  written.set(
    join(APP_RETICLE, 'cloud.json').split('\\').join('/'),
    JSON.stringify({ projectId, url: CLOUD }),
  );
  written.set(
    join(HOME, ReticleDir.ROOT, 'credentials.json').split('\\').join('/'),
    JSON.stringify({ [`${CLOUD}::${projectId}`]: 'rk_live_x' }),
  );
  return fs;
}

/**
 * A server that answers the way the PLATFORM does: the project id on the envelope, the entries
 * carrying none of their own.
 *
 * The shape matters more than the helper. The first cut of this fix filtered the ENTRIES and was
 * tested against entries that carried a `projectId` — a shape the platform never sends — so the
 * filter matched nothing, kept everything, and every test passed. `answerAs` lets a test say which
 * project the server ANSWERED about, which is the thing under test.
 */
function answerAs(projectId: string | undefined, entries: readonly unknown[]): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(url);
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ ...(projectId === undefined ? {} : { projectId }), entries }),
    });
  });
  return { urls };
}

/** The common case: the server answered about the project that was asked about. */
const answering = (entries: readonly unknown[]): { urls: string[] } => answerAs(LINKED, entries);

describe('which project a shared-memory read is about', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * #1247. The key covers a whole workspace, so a read that named no project could be answered with
   * a repo B agent holding repo A's established knowledge — every entry valid, attributed to B, and
   * wrong. `cloud.json` has always carried the id; this is the line that finally sends it.
   */
  it('names the linked project on the wire', async () => {
    const { urls } = answering([]);

    await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { subject: 'checkout', limit: 10 });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`${CLOUD}/v1/memory?subject=checkout&projectId=${LINKED}`);
  });

  /** A read across the whole project is still scoped — the subject was never what scoped it. */
  it('names the linked project even with no subject', async () => {
    const { urls } = answering([]);

    await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { limit: 10 });

    expect(urls[0]).toBe(`${CLOUD}/v1/memory?projectId=${LINKED}`);
  });

  /**
   * The regression for the shape this was actually broken against, and the reason the entry-level
   * test below could not catch it.
   *
   * The platform answers with `{ projectId, entries }` — the entries carry no project of their own.
   * A reader that only filtered entries saw nothing to compare, kept the whole list, and returned a
   * sibling project's knowledge under this project's heading with every test still green.
   */
  it('refuses a response whose ENVELOPE names another project, as unverified', async () => {
    answerAs(SIBLING, [
      { statement: 'theirs', status: 'proved' },
      { statement: 'also theirs', status: 'agreed' },
    ]);

    const result = await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { limit: 10 });

    // NOT `ok: true` with an empty list. "This project knows nothing" is a fact an agent acts on;
    // the honest answer here is that nothing could be established, which is a different thing.
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe(MemoryUnavailable.UNVERIFIED);
  });

  /**
   * A server that never says which project it answered about — an older one, or the platform before
   * it learned the parameter. Unverifiable, and reported as such rather than as an empty corpus.
   */
  it('refuses a response whose envelope names no project, as unverified', async () => {
    answerAs(undefined, [{ statement: 'whose?', status: 'proved' }]);

    const result = await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { limit: 10 });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe(MemoryUnavailable.UNVERIFIED);
  });

  /**
   * An entry that says nothing is KEPT, once the envelope has vouched for the response: dropping it
   * would blank the corpus against every server that labels the envelope and not the entries, which
   * is the server this actually talks to.
   */
  it('keeps an entry that does not say which project it belongs to', async () => {
    answering([{ statement: 'unsaid', status: 'agreed' }]);

    const result = await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { limit: 10 });

    expect(result.ok && result.known.map((k) => k.statement)).toEqual(['unsaid']);
  });

  /**
   * The second pass, for a server that labels ENTRIES instead of the envelope — not the platform's
   * shape, and the filter is still worth having for one that is. `total` is counted after the drop,
   * so a truncated list tells the truth about THIS project's corpus rather than the workspace's.
   */
  it('drops an entry that says it belongs to another project, and does not count it', async () => {
    answering([
      { statement: 'theirs', status: 'proved', projectId: SIBLING },
      { statement: 'ours', status: 'proved', projectId: LINKED },
    ]);

    const result = await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { limit: 10 });

    expect(result.ok && result.known.map((k) => k.statement)).toEqual(['ours']);
    expect(result.ok && result.total).toBe(1);
  });

  /**
   * The unlinked case, and the one place a refusal would be wrong: with no `cloud.json` there is no
   * project to contradict, so an answer about anything is read the way it always was. CI is this
   * path, and refusing here would break every single-project install to fix a leak that needs two.
   */
  it('reads a response normally when this project is not linked', async () => {
    answerAs('some-other-project', [{ statement: 'readable', status: 'proved' }]);
    // No `cloud.json`: the env-credential path, which is the whole of CI. With no link file there
    // is no linked id for the envelope to contradict, so the read happens the way it always did.
    const { fs } = createMemoryFs();

    const result = await readProjectMemory(
      fs,
      APP_RETICLE,
      HOME,
      { RETICLE_API_KEY: 'rk_live_x' },
      { limit: 10 },
    );

    expect(result.ok && result.known.map((k) => k.statement)).toEqual(['readable']);
  });
});
