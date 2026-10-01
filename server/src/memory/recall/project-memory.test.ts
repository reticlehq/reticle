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
import { rankKnown, readProjectMemory, type KnownThing } from './project-memory.js';

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

/** A server that answers with the entries it is given, and records the URL it was asked at. */
function answering(entries: readonly unknown[]): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(url);
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ entries }),
    });
  });
  return { urls };
}

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
   * The client half, for as long as the platform does not filter on the parameter. `total` is
   * counted after the drop, so a truncated list still tells the truth about THIS project's corpus
   * rather than about the workspace's.
   */
  it('drops a statement that says it belongs to another project, and does not count it', async () => {
    answering([
      { statement: 'theirs', status: 'proved', projectId: SIBLING },
      { statement: 'ours', status: 'proved', projectId: LINKED },
    ]);

    const result = await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { limit: 10 });

    expect(result.ok && result.known.map((k) => k.statement)).toEqual(['ours']);
    expect(result.ok && result.total).toBe(1);
  });

  /**
   * An entry that does not say is KEPT. Dropping those would blank the corpus against every server
   * that does not send the field — a leak between two repos traded for every project reading as
   * empty, and empty is the answer that looks like a fact rather than a failure.
   */
  it('keeps an entry that does not say which project it belongs to', async () => {
    answering([{ statement: 'unsaid', status: 'agreed' }]);

    const result = await readProjectMemory(linked(), APP_RETICLE, HOME, {}, { limit: 10 });

    expect(result.ok && result.known.map((k) => k.statement)).toEqual(['unsaid']);
  });
});
