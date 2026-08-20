import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';

/**
 * The `.reticle/` entries that are LOCAL state, and must never be committed by accident.
 *
 * Split from the durable half deliberately, and the split is the whole design: `contract.json`,
 * `flows/`, `baselines/` and `capsules/` are meant to be checked in — a flow that cannot be shared
 * is not a regression check anybody else can run — while everything below is per-machine churn.
 *
 * The reason this matters beyond tidiness: a session journal carries URLs, request and response
 * bodies, and DOM text from the app under test. `.reticle/` is created by the daemon rather than by
 * the user, so it arrives untracked and unexplained, and one `git add -A` puts an app's traffic into
 * a shared repository. Reticle created the directory; the ignore for it is Reticle's to write.
 */
const TRANSIENT: readonly string[] = [
  `${ReticleDir.SESSIONS_SUBDIR}/`,
  `${ReticleDir.RUNS_SUBDIR}/`,
  `${ReticleDir.VISUAL_SUBDIR}/`,
  ReticleDir.PROJECT_FILE,
  ReticleDir.AMBIENT_FILE,
  ReticleDir.ENVELOPES_FILE,
  ReticleDir.FLAKE_FILE,
  ReticleDir.TIERS_FILE,
  '*.log',
  '*.tmp',
];

const HEADER = [
  '# Written by Reticle, and only about the directory Reticle owns.',
  '#',
  '# The entries below are per-machine state — session journals, run artifacts, learned envelopes.',
  '# Journals contain URLs, request and response bodies and page text from the app under test, so',
  '# they are worth keeping out of a shared repository on their own account.',
  '#',
  `# Deliberately NOT ignored: ${ReticleDir.CONTRACT_FILE}, ${ReticleDir.FLOWS_SUBDIR}/, ${ReticleDir.BASELINES_SUBDIR}/ and`,
  `# ${ReticleDir.CAPSULES_SUBDIR}/. Those are meant to be committed — a saved flow only earns its keep`,
  '# when a teammate or CI can replay it.',
  '#',
  '# Edit freely: Reticle writes this once and never rewrites it.',
];

/**
 * Write `.reticle/.gitignore` if it is not already there.
 *
 * Never overwrites — once the file exists it belongs to whoever edited it last, and silently
 * reverting somebody's change to a file we placed in their repository is worse than not having
 * written it. Best-effort throughout: this runs on the daemon's start path, and a workspace that
 * cannot be written must not stop a daemon coming up. Nothing about verification depends on it.
 */
export async function ensureWorkspaceGitignore(fs: FileSystemPort, root: string): Promise<void> {
  const path = join(root, '.gitignore');
  try {
    if (await fs.exists(path)) return;
    await fs.mkdir(root);
    await fs.writeFile(path, `${[...HEADER, '', ...TRANSIENT].join('\n')}\n`);
  } catch {
    /* a workspace we cannot write is not a reason to fail a session */
  }
}
