import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../repo-root.js';

/**
 * Exactly how much of the protocol the shipping product uses, stated as a number nobody can round.
 *
 * The honest answer today is NONE, and it needs to be written somewhere a claim can be checked
 * against, because it has already been got wrong twice in this release — once in the progress
 * log and once in an answer given to the person asking. Both said the protocol reaches
 * production "in exactly one place, the SubjectRef on a run artifact". Measured, that is not so:
 *
 *   - `ReticleVerificationRun.subject` is `SubjectRefSchema.optional()` and **nothing writes
 *     it**. It is a field of the right type that no production path fills.
 *   - `toArtifact` — the thing stamped `kind: OPENREALITY_ARTIFACT_KIND` — carries a subject
 *     shaped `{ name, commit?, url? }`, which the protocol does not define. Not a SubjectRef.
 *   - The one function that builds a real `SubjectRef` is `core`'s `subjectOf`, reached only
 *     through `WebRealm.identity()`, and **`WebRealm` is constructed only by the two
 *     conformance runners**.
 *
 * None of that is a defect. The product is *scored against* the specification on two real
 * surfaces, by the specification's own `adjudicate`, which is a stronger arrangement than most
 * specifications ever get — and rewiring production verdicts through the protocol is an
 * architectural change deliberately not started inside a stability release.
 *
 * What IS a defect is saying otherwise. So this pins the boundary: if the product starts
 * implementing the protocol, this test fails and someone updates the claim in the same commit
 * that earns it.
 */

/** Source with comments stripped: this file's subject is imports, and prose mentions them. */
function code(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function tracked(...globs: string[]): string[] {
  return execFileSync('git', ['ls-files', ...globs], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => '' !== f && f.endsWith('.ts') && !f.includes('.test.'));
}

describe('how much of the protocol the shipping product uses', () => {
  it('reads the source, so an empty answer cannot mean it read nothing', () => {
    expect(tracked('server/src', 'core/src', 'adapters').length).toBeGreaterThan(100);
    // And the stripper must strip: this phrase lives only in a comment above.
    expect(code('server/src/connection/realm/web-realm.ts')).not.toContain('a constant here');
  });

  it('builds a realm only in the conformance runners, never in the product', () => {
    const builders = [...tracked('server/src', 'core/src', 'adapters'), 'conformance/run-self.mjs']
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => code(f).includes('new WebRealm'));
    expect(
      builders,
      'a product file now constructs a realm. That is the protocol entering the shipping ' +
        'path, which is a real change and a good one — update the claim in this file, and in ' +
        'plan/future/v3.0.0/progress.md, in the same commit.',
    ).toEqual([]);
  });

  it('leaves the run artifact subject unwritten, rather than half-written', () => {
    // Half-written would be worse than empty: a SubjectRef with an invented `instance` is a
    // subject that cannot be distinguished from a real one, and the schema's own comment says
    // an invented subject is worse than an absent one.
    const writers = tracked('server/src', 'core/src').filter((f) =>
      /subject:\s*subjectOf\(|subject:\s*this\.identity\(\)/.test(code(f)),
    );
    expect(writers).toEqual(['server/src/connection/realm/web-realm.ts']);
  });

  it('has no caller for the artifact exporter, which is the third disconnected piece', () => {
    // The seam from this product to the protocol is built in three parts and joined in none:
    //
    //   SubjectRef on the run   declared, written by nothing        (asserted above)
    //   WebRealm                constructed only by conformance     (asserted above)
    //   toArtifact              exported, imported by nothing       (here)
    //
    // Each is individually honest — `to-artifact.ts` is in server's DECLARED_UNWIRED list with
    // the reason "no production path reaches it" — and the three together are the whole story,
    // which no single declaration says. `b4217853` is titled "export a run in a format somebody
    // else could read"; nothing reads it because nothing produces it.
    //
    // Not a defect to fix by wiring something arbitrary: where the export surfaces (a CLI
    // command, a tool, a file written when a run completes) is a product decision with three
    // reasonable answers. It is a defect to leave unstated, which is what this prevents.
    const callers = tracked('server/src', 'core/src', 'adapters').filter(
      (f) =>
        f !== 'server/src/agent/runs/artifact/to-artifact.ts' && code(f).includes('toArtifact'),
    );
    expect(
      callers,
      'something now calls toArtifact. The protocol export has a consumer, which is a real ' +
        'change — update the three-part claim in this file and in the changelog.',
    ).toEqual([]);
  });

  it('exports an artifact whose subject is deliberately not the protocol shape', () => {
    // Pinned so that changing one without the other is loud. The exported shape is Reticle's,
    // the protocol's is SubjectRef, and today they are different on purpose.
    const artifact = code('server/src/agent/runs/artifact/to-artifact.ts');
    expect(artifact).toContain('OPENREALITY_ARTIFACT_KIND');
    expect(artifact).not.toContain('SubjectRef');
  });
});
