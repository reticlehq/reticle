/**
 * A memory read is about ONE project, and it says so.
 *
 * `GET /v1/memory` was asked with the API key and a subject and nothing else. The key covers a whole
 * workspace, so with two repos linked to one workspace, repo B's agent could be handed repo A's
 * established knowledge — every entry valid, attributed to B, and wrong. The link file has always
 * carried the project id; it just never reached the URL.
 */
import { describe, expect, it } from 'vitest';
import {
  isReadableMemoryScope,
  keepOwnProject,
  memoryReadUrl,
  MemoryResponseScope,
  MemoryScopeField,
  scopedMemoryEntries,
  scopeMemoryResponse,
  scopeOfMemoryResponse,
} from './memory-scope.js';

const BASE = 'https://cloud.test';

describe('the URL a memory read is made at', () => {
  it('names the linked project, which is the whole point', () => {
    expect(memoryReadUrl(BASE, { projectId: 'repo-b', subject: 'checkout' })).toBe(
      `${BASE}/v1/memory?subject=checkout&projectId=repo-b`,
    );
  });

  /** A read across the whole project is still scoped — the subject was never what scoped it. */
  it('carries the project even with no subject', () => {
    expect(memoryReadUrl(BASE, { projectId: 'repo-b' })).toBe(`${BASE}/v1/memory?projectId=repo-b`);
  });

  it('encodes both values rather than splicing them into the query', () => {
    const url = memoryReadUrl(BASE, { projectId: 'a b&c', subject: 'check/out' });
    expect(url).toBe(`${BASE}/v1/memory?subject=check%2Fout&projectId=a%20b%26c`);
  });

  /**
   * An unlinked project has no id to send, and inventing one would scope the read to a project the
   * server has never heard of and return nothing. The env-credential path (CI) is the case.
   */
  it('sends no project when the link declares none', () => {
    expect(memoryReadUrl(BASE, { projectId: undefined, subject: 'checkout' })).toBe(
      `${BASE}/v1/memory?subject=checkout`,
    );
  });

  it('is a bare path when there is neither', () => {
    expect(memoryReadUrl(BASE, { projectId: undefined })).toBe(`${BASE}/v1/memory`);
  });
});

describe('what survives the response', () => {
  const entry = (projectId?: string): Record<string, unknown> => ({
    statement: 'a checkout clears the cart',
    status: 'proved',
    ...(projectId === undefined ? {} : { [MemoryScopeField.PROJECT_ID]: projectId }),
  });

  /**
   * The client half of the fix, and the reason it is not redundant with the parameter: the platform
   * filters on `projectId` only once it has been taught to, and until then this is what stands
   * between one repo's agent and another repo's corpus.
   */
  it('drops an entry that says it belongs to another project', () => {
    const kept = keepOwnProject([entry('repo-a'), entry('repo-b')], 'repo-b');
    expect(kept).toEqual([entry('repo-b')]);
  });

  /**
   * Silence is kept, deliberately. Dropping an entry that does not say would blank the corpus against
   * every server that does not send the field — trading a leak between two repos for every project
   * reading as empty, and empty is the answer that looks like a fact rather than a failure.
   */
  it('keeps an entry that does not say which project it belongs to', () => {
    expect(keepOwnProject([entry()], 'repo-b')).toEqual([entry()]);
  });

  it('keeps every entry when this read cannot name a project to compare against', () => {
    expect(keepOwnProject([entry('repo-a'), entry()], undefined)).toEqual([
      entry('repo-a'),
      entry(),
    ]);
  });

  /** The wire is somebody else's server: a number or an object is "does not say", not a match. */
  it('refuses to read a project out of a value that is not a string', () => {
    const odd = [{ [MemoryScopeField.PROJECT_ID]: 7 }, { [MemoryScopeField.PROJECT_ID]: {} }];
    expect(keepOwnProject(odd, 'repo-b')).toEqual(odd);
  });

  it('passes through a malformed entry rather than throwing on it', () => {
    expect(keepOwnProject([null, 'nonsense'], 'repo-b')).toEqual([null, 'nonsense']);
  });
});

/**
 * The check that actually works, and the one whose absence shipped.
 *
 * The platform puts `projectId` on the RESPONSE ENVELOPE — `{ projectId, entries }` — and not on each
 * entry. An entry-level filter therefore sees no project field anywhere, keeps everything, and reads
 * exactly like a fix: it has a test, it passes, and the leak is untouched. These are the regressions
 * that would have caught it, written against the platform's real shape.
 */
describe('what the response envelope says about which project it is about', () => {
  /** The platform's actual answer to `GET /v1/memory`. */
  const envelope = (projectId?: string, entries: unknown[] = []): Record<string, unknown> => ({
    ...(projectId === undefined ? {} : { [MemoryScopeField.PROJECT_ID]: projectId }),
    entries,
  });

  it('accepts an envelope that names the project this read asked about', () => {
    expect(scopeOfMemoryResponse(envelope('repo-b'), 'repo-b')).toBe(MemoryResponseScope.OWN);
    expect(isReadableMemoryScope(MemoryResponseScope.OWN)).toBe(true);
  });

  /** #1247, in its real shape: the server answered about a sibling and every entry looked fine. */
  it('refuses an envelope that names ANOTHER project', () => {
    expect(scopeOfMemoryResponse(envelope('repo-a'), 'repo-b')).toBe(MemoryResponseScope.OTHER);
    expect(isReadableMemoryScope(MemoryResponseScope.OTHER)).toBe(false);
  });

  /**
   * The distinction the whole change rests on. A server that never says which project it answered
   * about is UNSCOPED, not empty: refusing is the only honest answer, and an empty list would report
   * a fact nobody established.
   */
  it('refuses an envelope that names no project at all', () => {
    expect(scopeOfMemoryResponse(envelope(), 'repo-b')).toBe(MemoryResponseScope.UNSCOPED);
    expect(isReadableMemoryScope(MemoryResponseScope.UNSCOPED)).toBe(false);
  });

  it('refuses an envelope whose project field is not a non-empty string', () => {
    for (const stated of [7, {}, '', null, []]) {
      expect(
        scopeOfMemoryResponse({ [MemoryScopeField.PROJECT_ID]: stated, entries: [] }, 'repo-b'),
      ).toBe(MemoryResponseScope.UNSCOPED);
    }
  });

  /** A body that is not an object cannot be shown to be about anything, so it is refused too. */
  it('refuses a body it cannot read an envelope out of', () => {
    for (const body of [null, 'nonsense', 7, []]) {
      expect(scopeOfMemoryResponse(body, 'repo-b')).toBe(MemoryResponseScope.UNSCOPED);
    }
  });

  /**
   * The unlinked case (CI, and a setup that never ran `reticle link`): there is no project to
   * contradict, so the response is read the way it always was. Refusing here would break every
   * single-project install to fix a leak that needs two.
   */
  it('reads a response when this read named no project to begin with', () => {
    expect(scopeOfMemoryResponse(envelope('repo-a'), undefined)).toBe(
      MemoryResponseScope.NOT_ASKED,
    );
    expect(scopeOfMemoryResponse(envelope('repo-a'), null)).toBe(MemoryResponseScope.NOT_ASKED);
    expect(scopeOfMemoryResponse(envelope('repo-a'), '')).toBe(MemoryResponseScope.NOT_ASKED);
    expect(isReadableMemoryScope(MemoryResponseScope.NOT_ASKED)).toBe(true);
  });
});

describe('the entries a reader is allowed to see', () => {
  const own = { statement: 'ours', status: 'proved', [MemoryScopeField.PROJECT_ID]: 'repo-b' };
  const theirs = { statement: 'theirs', status: 'proved', [MemoryScopeField.PROJECT_ID]: 'repo-a' };

  it('hands back the entries of an envelope that names this project', () => {
    expect(scopedMemoryEntries({ projectId: 'repo-b', entries: [own] }, 'repo-b')).toEqual([own]);
  });

  /**
   * The defect this pair exists for: against the platform's real shape the entry-level filter alone
   * returned a sibling's whole corpus, because no entry carries a project field to filter on.
   */
  it('hands back NOTHING for an envelope that names another project', () => {
    expect(scopedMemoryEntries({ projectId: 'repo-a', entries: [own, theirs] }, 'repo-b')).toBe(
      undefined,
    );
  });

  it('hands back NOTHING for an envelope that names no project', () => {
    expect(scopedMemoryEntries({ entries: [own] }, 'repo-b')).toBe(undefined);
  });

  /** Still filtered, for a server that labels entries instead of the envelope. */
  it('still drops an entry that disagrees even when the envelope agrees', () => {
    expect(scopedMemoryEntries({ projectId: 'repo-b', entries: [own, theirs] }, 'repo-b')).toEqual([
      own,
    ]);
  });

  /** The envelope was accepted; a body without a readable list is a shape we cannot use. */
  it('hands back NOTHING when the accepted envelope carries no entries array', () => {
    expect(scopedMemoryEntries({ projectId: 'repo-b' }, 'repo-b')).toBe(undefined);
    expect(scopedMemoryEntries({ projectId: 'repo-b', entries: 'x' }, 'repo-b')).toBe(undefined);
  });
});

/**
 * The envelope-shaped reader refuses on its own, which is the whole point of it returning a union.
 *
 * It used to hand back whatever it was given and rely on a JSDoc line telling callers to check the
 * envelope first. That is the failure this module exists to document — a fix whose coverage is
 * asserted in a comment and nowhere else — written one function below the lesson. A reader that
 * hands a body back cannot refuse it, so on the day somebody calls it first, it prints a sibling
 * project's knowledge with nothing to stop it. It now answers `undefined` for anything it cannot
 * show to be this project's, so the unsafe call is not expressible.
 */
describe('printing a response, when it can be shown to be this project', () => {
  const own = { statement: 'ours', status: 'proved' };

  it('hands back the envelope with its entries filtered', () => {
    expect(scopeMemoryResponse({ projectId: 'repo-b', entries: [own] }, 'repo-b')).toEqual({
      projectId: 'repo-b',
      entries: [own],
    });
  });

  /** Preserved, not rebuilt: a diagnostic command shows what arrived, minus the other project's. */
  it('keeps every other field the server sent', () => {
    expect(
      scopeMemoryResponse({ projectId: 'repo-b', cursor: '9:3', entries: [own] }, 'repo-b'),
    ).toEqual({ projectId: 'repo-b', cursor: '9:3', entries: [own] });
  });

  /**
   * The refusal, and it is the same one the other three readers make. `undefined` rather than the
   * body: a caller cannot print what it was not handed, which is the property a comment could not
   * give it.
   */
  it('hands back NOTHING for an envelope that names another project', () => {
    expect(scopeMemoryResponse({ projectId: 'repo-a', entries: [own] }, 'repo-b')).toBe(undefined);
  });

  it('hands back NOTHING for an envelope that names no project', () => {
    expect(scopeMemoryResponse({ entries: [own] }, 'repo-b')).toBe(undefined);
  });

  it('hands back NOTHING for a body it cannot read an envelope out of', () => {
    for (const body of [null, 'nonsense', 7, []]) {
      expect(scopeMemoryResponse(body, 'repo-b')).toBe(undefined);
    }
  });

  /** Unlinked, but still not an envelope — there is nothing here to print as one. */
  it('hands back NOTHING for a non-object body even when no project was named', () => {
    expect(scopeMemoryResponse(null, undefined)).toBe(undefined);
  });

  /** Accepted, and the shape is odd: handed back as it arrived, same as the other reader. */
  it('hands back an accepted envelope whose entries is not an array', () => {
    expect(scopeMemoryResponse({ projectId: 'repo-b', entries: 'x' }, 'repo-b')).toEqual({
      projectId: 'repo-b',
      entries: 'x',
    });
  });
});
