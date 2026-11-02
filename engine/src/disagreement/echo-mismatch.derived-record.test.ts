/**
 * #1522: an endpoint that takes one record and returns a different record of the same type is not a
 * write the server ignored.
 *
 * A transform such as "summarize this artifact" sends an artifact descriptor and answers with a new
 * artifact: its own content hash, its own producer, its own kind. The field names match, so every
 * shared scalar was compared, every one disagreed, and the verdict was `write-field-ignored` / `no`
 * on a call whose declared `net` predicates all passed. #1345 fixed the timestamp version of this.
 *
 * Two rules close it. A content-derived key (a hash, digest or checksum) is exempt like an identity
 * key: it is computed from the record, so a new record has a new one. And when two or more compared
 * keys all disagree, nothing was echoed, so the response is a new record and the rule abstains. A
 * partial echo, where one key comes back as sent and another does not, still fires.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findEchoMismatches } from './echo-mismatch.js';

const DIGEST_A = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const DIGEST_B = '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752';

let seq = 0;
const write = (requestBody: unknown, responseBody: unknown, method = 'POST'): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: ++seq,
    data: {
      id: `n${String(seq)}`,
      method,
      url: '/api/derive',
      status: 200,
      ok: true,
      requestBody: JSON.stringify(requestBody),
      responseBody: JSON.stringify(responseBody),
    },
  }) as unknown as ReticleEvent;

const kinds = (e: ReticleEvent): string[] => findEchoMismatches([e]).map((c) => c.kind);

describe('a response that is a different record is not an echo', () => {
  it('stays silent on the derive repro from the issue', () => {
    expect(
      kinds(
        write(
          {
            artifact: {
              producer: 'a',
              sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
              kind: 'doc',
            },
          },
          {
            artifact: {
              producer: 'b',
              sha256: '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752',
              kind: 'summary',
            },
          },
        ),
      ),
    ).toEqual([]);
  });

  it('stays silent when every key differs and the response names a different id', () => {
    expect(
      kinds(
        write(
          { id: 'a1', title: 'Q3 report', kind: 'doc' },
          { id: 'a2', title: 'Q3 summary', kind: 'summary' },
        ),
      ),
    ).toEqual([]);
  });

  it('still fires when every key differs and nothing names a different identity', () => {
    // No id and no hash came back different, so nothing says this is another record: it may be the
    // same record with the whole write ignored.
    expect(
      kinds(write({ title: 'Q3 report', kind: 'doc' }, { title: 'Q3 summary', kind: 'summary' })),
    ).toEqual([ContradictionKind.WRITE_FIELD_IGNORED]);
  });

  it('still fires on a partial echo: one key kept, one changed', () => {
    const found = findEchoMismatches([
      write({ density: 'compact', locale: 'fr' }, { saved: { density: 'compact', locale: 'en' } }),
    ]);
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.WRITE_FIELD_IGNORED]);
    expect(found[0]?.counter).toContain('locale: asked fr, got en');
  });

  it('still fires on a one-key write whose key comes back different', () => {
    // One disagreeing key is not "every key of a different record"; it is the archetype.
    expect(kinds(write({ qty: 5 }, { saved: { qty: 3 } }))).toEqual([
      ContradictionKind.WRITE_FIELD_IGNORED,
    ]);
  });
});

describe('content-derived keys are exempt, like identity keys', () => {
  it.each([
    'sha256',
    'sha1',
    'SHA512',
    'sha',
    'content_sha256',
    'fileSha',
    'hash',
    'contentHash',
    'content_hash',
    'checksum',
    'md5',
    'digest',
    'payloadDigest',
    'etag',
  ])('a %s that changed is not a dropped field', (key) => {
    expect(
      kinds(
        write({ name: 'report', [key]: DIGEST_A }, { saved: { name: 'report', [key]: DIGEST_B } }),
      ),
    ).toEqual([]);
  });

  it.each(['shape', 'shared', 'hashtag', 'digestible'])(
    'a %s key is a persisted attribute, and is still compared',
    (key) => {
      expect(
        kinds(write({ name: 'report', [key]: 'one' }, { saved: { name: 'report', [key]: 'two' } })),
      ).toEqual([ContradictionKind.WRITE_FIELD_IGNORED]);
    },
  );
});

describe('a server that ignored the whole write still fires (#1627 review)', () => {
  it('a fully ignored PATCH, though its id comes back the same', () => {
    expect(
      kinds(
        write(
          { name: 'New', email: 'new@x.io' },
          { id: 7, name: 'Old', email: 'old@x.io' },
          'PATCH',
        ),
      ),
    ).toEqual([ContradictionKind.WRITE_FIELD_IGNORED]);
  });

  it('a fully ignored PUT of settings', () => {
    expect(
      kinds(write({ theme: 'dark', locale: 'fr' }, { theme: 'light', locale: 'en' }, 'PUT')),
    ).toEqual([ContradictionKind.WRITE_FIELD_IGNORED]);
  });

  it('a PATCH whose response names a different hash is still an update, and still fires', () => {
    expect(
      kinds(
        write(
          {
            title: 'New',
            kind: 'doc',
            sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          },
          {
            title: 'Old',
            kind: 'memo',
            sha256: '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752',
          },
          'PATCH',
        ),
      ),
    ).toEqual([ContradictionKind.WRITE_FIELD_IGNORED]);
  });

  it('an addressed write never reads as a new record', () => {
    expect(
      kinds(
        write(
          { field: 'locale', value: 'fr', mode: 'a', id: 'p1' },
          { field: 'theme', value: 'en', mode: 'b', id: 'p2' },
        ),
      ),
    ).toContain(ContradictionKind.WRITE_FIELD_IGNORED);
  });
});

/** A key that says `digest` or `hash` is not a hash when its value is a setting. */
describe('a settings field whose name contains a digest word', () => {
  const patch = (asked: unknown, got: unknown): string[] => kinds(write(asked, got, 'PATCH'));

  it('fires for a boolean the server ignored', () => {
    expect(patch({ weeklyDigest: false }, { weeklyDigest: true })).toContain(
      ContradictionKind.WRITE_FIELD_IGNORED,
    );
  });

  it('fires for a short word the server ignored', () => {
    expect(patch({ digest: 'daily' }, { digest: 'weekly' })).toContain(
      ContradictionKind.WRITE_FIELD_IGNORED,
    );
  });

  it('fires for a long dictionary word, which is valid base64 text', () => {
    expect(patch({ digest: 'everyday' }, { digest: 'fortnightly' })).toContain(
      ContradictionKind.WRITE_FIELD_IGNORED,
    );
  });

  it('fires for a number, which is not a digest however long', () => {
    expect(patch({ hashLimit: 12345678 }, { hashLimit: 87654321 })).toContain(
      ContradictionKind.WRITE_FIELD_IGNORED,
    );
  });

  it.each([
    ['hex', DIGEST_A, DIGEST_B],
    ['labelled hex', `sha256:${DIGEST_A.slice(0, 16)}`, `sha256:${DIGEST_B.slice(0, 16)}`],
    [
      'base64',
      'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
      'YDA64iuZiGG847KPM+7BvnWKITyGyTwHbb6fVYwRx1I=',
    ],
  ])('stays silent for a real %s digest answered with a different one', (_shape, asked, got) => {
    expect(patch({ sha256: asked, name: 'report' }, { sha256: got, name: 'report' })).toEqual([]);
  });
});
