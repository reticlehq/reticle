/**
 * One name for one storage area.
 *
 * Three files described the same three areas in three different vocabularies. `@reticlehq/core`
 * defined the enum and fed it to the `STORAGE_CHANGED` payload; `read-tools.ts` re-declared the same
 * three values as a fresh literal list; and the browser observer compared against a bare string two
 * lines after using the enum correctly for its siblings. The three did not agree, and the one that
 * disagreed was the enum every other file was supposed to be reading from.
 *
 * Nothing crashed, because the cookie member had no consumers at all. That is what made it worth
 * fixing rather than leaving: an unused member drifts for free, and the moment anything reads it,
 * Reticle mints a value its own tool refuses. An agent that takes the area from the wire contract and
 * hands it straight back to `reticle_storage` is the ordinary way to use these tools, and it would
 * have been told the value was invalid.
 *
 * Plural wins, because plural is what the tool already accepts, what the browser already returns, and
 * what the published docs already show. The singular was the outlier and the only one with no callers,
 * so aligning it breaks nothing that exists.
 *
 * These assertions read the SOURCE rather than the runtime values. A test comparing the two constants
 * would pass just as happily if both were wrong together, and the defect here was never a wrong value
 * in isolation, it was a second and third place to write one down.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageArea } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import { ReticleTool } from './tool-names.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string): string => readFileSync(join(REPO, path), 'utf8');

describe('one vocabulary for one storage area', () => {
  it('core spells the cookie area the way everything else already did', () => {
    expect(StorageArea.COOKIE).toBe('cookies');
  });

  it('the storage tool takes its accepted areas from core, not from a second list', () => {
    const source = read('packages/server/src/tools/read-tools.ts');
    expect(
      source.includes("'local', 'session', 'cookies'"),
      'read-tools.ts re-declares the storage areas as a literal list. A second copy of an enum is a ' +
        'second place for it to drift, and it already had: core said `cookie` while this said ' +
        '`cookies`. Build the schema from core’s StorageArea instead.',
    ).toBe(false);
    expect(source).toContain('StorageArea');
  });

  it('the browser observer matches the cookie area by the enum, not a bare string', () => {
    const source = read('packages/browser/src/observers/storage.ts');
    expect(
      /'cookies'\s*===\s*area/.test(source),
      'storage.ts compares `area` against a free string while the two lines above it use ' +
        'StorageArea for local and session. That is the inconsistency that let the spellings ' +
        'diverge in the first place.',
    ).toBe(false);
    expect(source).toContain('StorageArea.COOKIE');
  });

  it('every area core defines is one the storage tool will accept', () => {
    // The reachable failure, stated as a property rather than as the one case that had drifted: an
    // agent reads an area off the wire contract and hands it straight back to `reticle_storage`. If
    // the tool refuses a value Reticle itself minted, the agent cannot tell that from its own
    // mistake, and the honest report is that Reticle contradicted itself.
    //
    // Parsed against the REAL tool schema. Asserting the source mentions the enum would pass on a
    // file that imported it and then ignored it.
    const storage = READ_TOOLS.find((tool) => ReticleTool.STORAGE === tool.name);
    expect(storage, 'reticle_storage is not in READ_TOOLS').toBeDefined();
    const area = storage?.inputSchema['area'];
    expect(area, 'reticle_storage has no `area` input').toBeDefined();

    for (const value of Object.values(StorageArea)) {
      expect(
        area?.safeParse(value).success,
        `core defines the storage area "${value}" and reticle_storage refuses it.`,
      ).toBe(true);
    }
  });

  it('refuses an area core does not define, so the schema is narrow and not just permissive', () => {
    // Guards the guard. A schema of `z.string()` would satisfy every assertion above while accepting
    // anything at all, which is the failure this file would be least able to see.
    const storage = READ_TOOLS.find((tool) => ReticleTool.STORAGE === tool.name);
    expect(storage?.inputSchema['area']?.safeParse('cookie').success).toBe(false);
    expect(storage?.inputSchema['area']?.safeParse('indexeddb').success).toBe(false);
  });
});
