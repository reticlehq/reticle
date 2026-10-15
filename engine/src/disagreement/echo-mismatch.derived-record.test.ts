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

let seq = 0;
const write = (requestBody: unknown, responseBody: unknown): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: ++seq,
    data: {
      id: `n${String(seq)}`,
      method: 'POST',
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
          { artifact: { producer: 'a', sha256: '111', kind: 'doc' } },
          { artifact: { producer: 'b', sha256: '222', kind: 'summary' } },
        ),
      ),
    ).toEqual([]);
  });

  it('stays silent when two or more compared keys all disagree', () => {
    expect(
      kinds(write({ title: 'Q3 report', kind: 'doc' }, { title: 'Q3 summary', kind: 'summary' })),
    ).toEqual([]);
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
      kinds(write({ name: 'report', [key]: '111' }, { saved: { name: 'report', [key]: '222' } })),
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
