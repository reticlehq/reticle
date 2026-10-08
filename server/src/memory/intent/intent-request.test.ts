/**
 * The user's request, relayed by the agent, kept with the runs that verify it: classified,
 * attributed, redacted, and shared from a linked project unless it opts out.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptContextSchema, StatementSource } from '@reticlehq/core/artifacts';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { RunStore } from '@/judgement/runs/artifact/run-store.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { INTENT_TOOLS } from './intent-tools.js';

const ROOT = '/repo/.reticle';
const intentTool = INTENT_TOOLS[0];

function deps(now: number) {
  const { fs } = createMemoryFs();
  const d = {
    fs,
    reticleRoot: ROOT,
    now: () => now,
    sessions: {
      resolve: () => {
        throw new Error('no session');
      },
      count: () => 0,
    },
  } as unknown as ToolDeps;
  return { d, fs };
}

describe('the request behind a verification', () => {
  it('is kept classified, attributed and redacted', async () => {
    const { d, fs } = deps(1_000);
    const out = await intentTool?.handler(d, {
      action: 'declare',
      request:
        'Customers reorder a past purchase. The cart must show the total. token=sk_live_abcdef123456',
      intents: [{ id: 'reorder', statement: 'a reorder keeps the original sizes' }],
    });
    expect(out).toMatchObject({ intents: [{ id: 'reorder' }] });
    const saved = PromptContextSchema.parse(
      JSON.parse(await fs.readFile(reticleDirPaths(ROOT).request)),
    );
    expect(saved.request).not.toContain('sk_live_abcdef123456');
    expect(saved.shared).toBe(false);
    expect(saved.statements.map((s) => [s.kind, s.source])).toEqual([
      ['business-intent', StatementSource.USER],
      ['acceptance-criterion', StatementSource.USER],
      expect.arrayContaining([StatementSource.USER]),
      ['business-intent', StatementSource.AGENT],
    ]);
  });

  it('rides on a run written soon after, and not on one long after', async () => {
    const { d, fs } = deps(1_000);
    await intentTool?.handler(d, { action: 'declare', request: 'Add reorder' });
    const store = new RunStore(fs, ROOT);
    const run = (id: string, createdAt: number) =>
      ({ runId: id, createdAt, flows: [], checks: [] }) as never;
    await store.write(run('run-soon', 2_000));
    await store.write(run('run-later', 1_000 + 7 * 60 * 60 * 1000));
    const soon = JSON.parse(await fs.readFile(`${ROOT}/runs/run-soon.json`)) as {
      context?: { request?: string };
    };
    const later = JSON.parse(await fs.readFile(`${ROOT}/runs/run-later.json`)) as {
      context?: unknown;
    };
    expect(soon.context?.request).toBe('Add reorder');
    expect(later.context).toBeUndefined();
  });
});

describe('who the request is shared with', () => {
  const declare = async (projectConfig?: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-share-'));
    const root = join(dir, '.reticle');
    mkdirSync(root);
    writeFileSync(join(root, 'cloud.json'), '{"projectId":"p"}');
    if (projectConfig !== undefined)
      writeFileSync(join(dir, '.reticle.json'), JSON.stringify(projectConfig));
    const { d, fs } = deps(1_000);
    (d as { reticleRoot: string }).reticleRoot = root;
    await intentTool?.handler(d, { action: 'declare', request: 'Refund a payment' });
    return PromptContextSchema.parse(JSON.parse(await fs.readFile(reticleDirPaths(root).request)));
  };

  it('goes to the platform from a linked project by default', async () => {
    expect((await declare()).shared).toBe(true);
  });

  it('stays on this machine when the project says shareRequests: false', async () => {
    expect((await declare({ shareRequests: false })).shared).toBe(false);
  });
});
