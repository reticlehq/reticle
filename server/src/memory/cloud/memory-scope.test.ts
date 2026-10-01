/**
 * A memory read is about ONE project, and it says so.
 *
 * `GET /v1/memory` was asked with the API key and a subject and nothing else. The key covers a whole
 * workspace, so with two repos linked to one workspace, repo B's agent could be handed repo A's
 * established knowledge — every entry valid, attributed to B, and wrong. The link file has always
 * carried the project id; it just never reached the URL.
 */
import { describe, expect, it } from 'vitest';
import { keepOwnProject, memoryReadUrl, MemoryScopeField } from './memory-scope.js';

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
