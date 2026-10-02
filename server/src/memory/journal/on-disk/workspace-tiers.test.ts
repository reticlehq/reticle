import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import {
  Durability,
  EVIDENCE_DIRS,
  LOCAL_DIRS,
  LOCAL_FILES,
  Sharing,
  WORKSPACE_TIERS,
} from './workspace-tiers.js';

/**
 * Every name `.reticle/` can hold is classified on BOTH axes, so a new one cannot arrive
 * unclassified on either.
 *
 * The single list this replaces answered one question with one answer, and the two questions are
 * not the same question: `capsules/` is committed AND is evidence a drive left behind, a cell one
 * list cannot express. Because the classification was the gitignore's, retention read it as
 * "deletable" and capsules could never enter the byte budget however large they grew — not by
 * decision, but because there was nowhere to say it.
 */
describe('the two partitions of what .reticle holds', () => {
  /** Names that are not entries IN `.reticle/` — the root itself, and files inside a session dir. */
  const NOT_WORKSPACE_ENTRIES: readonly string[] = [
    ReticleDir.ROOT,
    ReticleDir.JOURNAL_EVENTS_FILE,
    ReticleDir.JOURNAL_ACTIONS_FILE,
    // Beside the event ledger, inside the same session dir, and ignored by the same `sessions/`
    // entry. It records that a ledger stopped writing, which is a fact about one machine's disk.
    ReticleDir.JOURNAL_EVENTS_CLOSED_FILE,
    // ~/.reticle, deliberately outside any repository: a pairing token must never reach one.
    ReticleDir.PAIRING_TOKEN_FILE,
  ];

  it('leaves nothing unclassified', () => {
    const classified = new Set([...Object.keys(WORKSPACE_TIERS), ...NOT_WORKSPACE_ENTRIES]);
    const unclassified = Object.values(ReticleDir).filter((name) => !classified.has(name));
    expect(
      unclassified,
      'a name .reticle/ can hold has no tier. Decide BOTH: `sharing` is whether a teammate or CI ' +
        'needs it to replay a flow, `durability` is whether retention may delete it to reclaim disk.',
    ).toEqual([]);
  });

  it('can express a committed directory that retention still owns', () => {
    const cells = new Set(
      Object.values(WORKSPACE_TIERS).map((tier) => `${tier.sharing}/${tier.durability}`),
    );
    expect(cells.has(`${Sharing.COMMIT}/${Durability.MEMORY}`)).toBe(true);
    expect(cells.has(`${Sharing.LOCAL}/${Durability.EVIDENCE}`)).toBe(true);
  });

  it('never ignores a name meant to be committed', () => {
    const ignored = [...LOCAL_DIRS, ...LOCAL_FILES];
    const committed = Object.entries(WORKSPACE_TIERS)
      .filter(([, tier]) => Sharing.COMMIT === tier.sharing)
      .map(([name]) => name);
    expect(committed.filter((name) => ignored.includes(name))).toEqual([]);
  });

  it('sweeps every evidence directory, whether or not it is ignored', () => {
    const swept = new Set(EVIDENCE_DIRS);
    const evidence = Object.entries(WORKSPACE_TIERS)
      .filter(([, tier]) => Durability.EVIDENCE === tier.durability && tier.isDirectory)
      .map(([name]) => name);
    expect(evidence.filter((name) => !swept.has(name))).toEqual([]);
  });
});
