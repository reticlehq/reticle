/**
 * `reticle context --compact [--session <id>]` — the resume block, read from disk with no daemon.
 *
 * Installed by `reticle init` as a Claude Code SessionStart hook with matcher `compact`: right after
 * a compaction, whatever this prints is put back into the agent's fresh context. So it must never
 * fail loudly — a hook that throws is an error the user did not cause — and it prints nothing when
 * this directory has no Reticle record at all.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { resumeFromDisk } from '@/judgement/runs/resume.js';
import { SessionJournal } from '@/memory/journal/session-journal.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';

export async function handleContext(session: string | undefined): Promise<void> {
  const root = join(process.cwd(), ReticleDir.ROOT);
  if (!existsSync(root)) return;
  try {
    const fs = createNodeFileSystem();
    const lines = await resumeFromDisk({
      root,
      now: Date.now(),
      fs,
      readActions: (id) => new SessionJournal(fs, root, id).readActions(),
      sessionId: session,
    });
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch {
    // Silent by design: see the header.
  }
}
