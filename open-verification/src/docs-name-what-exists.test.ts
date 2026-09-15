import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ground } from './spi/adjudicator.js';
import { Verdict } from './vocabulary/verdict.js';

/**
 * The published documents name only things that exist.
 *
 * A protocol is read by people who cannot check it against a running system, which is the whole
 * reason they are reading a document. A spec that names a method, a ground or a file which is not
 * there does not merely confuse them: it spends the one thing a specification has, which is being
 * believed. And the failure is silent, because prose does not compile.
 *
 * THE INCIDENT THIS WAS WRITTEN AFTER, and it happened to this very doc set within an hour of it
 * being written: CONFORMANCE.md cited two statements as "SPEC L544" and "SPEC L545". Editing SPEC.md
 * to add the BCP 14 keyword clamp moved those lines to 548 and 549, so both citations pointed at
 * unrelated prose while still looking authoritative. Line numbers are not addresses. Sections and
 * quoted sentences are, which is what those citations now use and what this test keeps true.
 */
const DIR = join(import.meta.dirname, '..');
const DOCS = [
  'SPEC.md',
  'README.md',
  'CONFORMANCE.md',
  'SECURITY.md',
  'VERSIONING.md',
  'EXTENSIONS.md',
  'CHANGELOG.md',
  'CHANGE-PROCESS.md',
  'docs/GLOSSARY.md',
  'docs/IMPLEMENTERS.md',
];
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');

describe('the published documents', () => {
  it('all exist, so a pass here is not a pass over nothing', () => {
    for (const doc of DOCS) expect(existsSync(join(DIR, doc)), doc).toBe(true);
  });

  it('cite no SPEC line numbers, which drift on the next edit', () => {
    const offenders: string[] = [];
    for (const doc of DOCS) {
      if ('SPEC.md' === doc) continue;
      for (const hit of read(doc).matchAll(/SPEC\s+L\d+/g)) offenders.push(`${doc}: ${hit[0]}`);
    }
    expect(
      offenders,
      'cite a section number and quote the sentence instead. A line number is not an address: it ' +
        'moves the next time anybody edits the spec, and the citation keeps looking authoritative ' +
        'while pointing at something else.',
    ).toEqual([]);
  });

  it('name every ground the adjudication order can return', () => {
    // A ground missing from CONFORMANCE.md is a clause an implementer is never told to check, and
    // the vectors alone will not tell them it exists.
    const text = read('CONFORMANCE.md') + read('SPEC.md');
    const missing = Object.values(Ground).filter((g) => !text.includes(g));
    expect(missing, 'these grounds are returned by adjudicate and named in no document').toEqual(
      [],
    );
  });

  it('name every verdict the protocol can produce', () => {
    const text = DOCS.map(read).join('\n');
    const missing = Object.values(Verdict).filter((v) => !text.includes(v));
    expect(missing).toEqual([]);
  });

  it('ships the vectors the documents point readers at', () => {
    // CONFORMANCE.md calls these the cheapest on-ramp. A missing file would make that advice a
    // dead end at exactly the moment somebody decided to try.
    const file = join(DIR, 'vectors', 'adjudication.json');
    expect(existsSync(file)).toBe(true);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { vectors: { ground: string }[] };
    expect([...doc.vectors.map((v) => v.ground)].sort()).toEqual([...Object.values(Ground)].sort());
  });
  it('ships every document it publishes, so npm i puts them beside the schemas', () => {
    /*
     * A document that exists in the repository and not in the tarball reaches nobody who installed
     * the package, which is the audience it was written for. CHANGELOG.md, CHANGE-PROCESS.md and the
     * whole `docs/` folder were each written and each left out of `files` until this checked.
     */
    const manifest = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    const shipped = manifest.files ?? [];
    const missing = DOCS.filter(
      (doc) => !shipped.includes(doc) && !shipped.includes(doc.split('/')[0] ?? ''),
    );
    expect(missing, 'add these to `files` in package.json or they do not ship').toEqual([]);
  });

  it('links every root document from the README, which is the only index a reader lands on', () => {
    const readme = read('README.md');
    const unlinked = DOCS.filter((doc) => 'README.md' !== doc && !readme.includes(doc));
    expect(unlinked, 'these are published and nothing points at them').toEqual([]);
  });
});
