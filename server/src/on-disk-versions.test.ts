import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './machine/repo-root.js';

/**
 * Every on-disk format version, pinned in one place.
 *
 * A store that reads a file written by an older version has to decide what to do about it, and the
 * quiet answer is the dangerous one. `assertion-tiers-store.ts` is the case that showed why: it
 * returns an empty baseline when the file does not match its schema, which is exactly right for a
 * corrupt file on one machine -- accusing somebody of weakening an assertion because their file was
 * unreadable would be worse than missing one downgrade -- and exactly wrong for a version bump,
 * which makes every baseline everywhere unreadable at the same moment. The anti-gaming check would
 * then pass forever with nothing to compare against, and no test would go red to say so.
 *
 * That reasoning is not special to one store. Any of these files can be silently emptied, downgraded
 * or ignored by a version change, and none of them announces it.
 *
 * So this pins the SET. Bumping any version turns it red, and the fix is not to update the number
 * here: it is to decide, in the same commit, what happens to the files already on disk -- convert
 * them, or tell the user they were reset -- and then update it.
 *
 * Deliberately a source scan rather than an import. The versions live in three shapes (an inline
 * literal, a named constant in the same file, a constant imported from core), and a scan sees all
 * three the same way without ten import lines that would themselves need maintaining.
 */

/**
 * file -> the version literal it declares, exactly as written.
 *
 * A named constant is recorded by its NAME, not its value: the point is to notice the declaration
 * moving, and a rename is as much a change as a renumber.
 */
const PINNED_VERSIONS: Record<string, string> = {
  'core/src/artifacts/flow-types.ts': 'FLOW_FILE_VERSION',
  'core/src/verdict/intent.ts': 'INTENT_FILE_VERSION',
  'core/src/registry/project-registry.ts': '1',
  'core/src/verdict/verification-run.ts': 'z.literal(RUN_FILE_VERSION',
  'core/src/artifacts/impact.ts': '.int().positive()',
  'core/src/wire/messages.ts':
    '.int().min(RETICLE_MIN_PROTOCOL_VERSION).max(RETICLE_PROTOCOL_VERSION)',
  'core/src/wire/types.ts': 'CONTRACT_FILE_VERSION,PROJECT_FILE_VERSION',
  // `Flow.version` in the protocol. A recorded route is written down and replayed later, so it is
  // an on-disk format like any other and belongs under this pin. Nothing reads a stored flow at a
  // version it does not understand yet -- there is only version 1 -- and the day there are two,
  // this line going red is the reminder to decide what happens to the ones already written.
  'openreality/src/vocabulary/memory.ts': '.int().positive()',
  'server/src/judgement/capsule/capsule-store.ts': 'CAPSULE_VERSION',
  'server/src/features/flows/stores/assertion-tiers-store.ts': '1',
  'server/src/features/flows/recording/flake.ts': '1',
  'server/src/memory/intent/intent-shard.ts': 'INTENT_SHARD_VERSION,INTENT_SHARD_VERSION',
  'server/src/memory/journal/on-disk/ambient-file.ts': '1',
  'server/src/memory/journal/envelope-store.ts': 'ENVELOPE_FILE_VERSION',
};

/** Every `version: z.literal(X)` in tracked source, as file -> comma-joined X values in file order. */
function declaredVersions(): Record<string, string> {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

  const found: Record<string, string> = {};
  for (const file of tracked) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      continue;
    }
    // Every shape a declared version takes: a single literal, a union of them, or a numeric range.
    //
    // It has been widened twice, both times because something it should have been watching turned
    // out to be invisible. It matched `version:` in lower case only, so a field named
    // `schemaVersion` -- the run artifact's -- was never seen. Then the protocol version became a
    // range rather than a fixed number, which is exactly the kind of change this exists to notice,
    // and the literal-only pattern would have dropped it silently.
    const matches = [
      ...text.matchAll(
        /version:\s*z\s*\.\s*(?:literal|union)\(([^;]+?)\)[,\n]|version:\s*z\s*\.\s*number\(\)([\s\S]{0,160}?)[,\n]\s*\/?\*?/gi,
      ),
    ].map((m) =>
      (m[1] ?? m[2] ?? '')
        .replace(/\s+/g, ' ')
        .replace(/^\[\s*/, '')
        .trim(),
    );
    if (matches.length > 0) found[file] = matches.join(',');
  }
  return found;
}

describe('on-disk format versions are pinned', () => {
  const declared = declaredVersions();

  it('finds the versioned stores at all', () => {
    // Without this, a change to how versions are written would empty the scan and the check below
    // would pass by having nothing to compare.
    expect(Object.keys(declared).length).toBeGreaterThanOrEqual(13);
  });

  it('no version has changed, and no store has appeared or vanished', () => {
    expect(
      declared,
      'An on-disk format version changed, or a store gained/lost one. Updating this pin is the LAST ' +
        'step, not the fix: decide first what happens to the files already on disk. Silently reading ' +
        'them as empty is how a guard stops guarding without anything going red -- see ' +
        'assertion-tiers-store.ts, whose empty-on-mismatch is right for a corrupt file and wrong for ' +
        'a version bump.',
    ).toEqual(PINNED_VERSIONS);
  });
});
