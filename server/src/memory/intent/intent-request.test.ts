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

/*
 * Persona drive: a second agent session on the same tab declared nothing, and its run carried the
 * first session's request as "What was asked" — a goal that run never had. A request rides on the
 * first run written for it; that run rewritten keeps it; another run does not inherit it.
 */
describe('a request belongs to the run that answered it', () => {
  it('is not inherited by the next run', async () => {
    const { d, fs } = deps(1_000);
    await intentTool?.handler(d, { action: 'declare', request: 'Sign in and check Diagnostics' });
    const store = new RunStore(fs, ROOT);
    const run = (id: string, createdAt: number) =>
      ({ runId: id, createdAt, flows: [], checks: [] }) as never;
    const read = async (id: string) =>
      (
        JSON.parse(await fs.readFile(`${ROOT}/runs/${id}.json`)) as {
          context?: { request?: string };
        }
      ).context;
    await store.write(run('drive-tab', 2_000));
    await store.write(run('drive-tab-2', 3_000));
    await store.write(run('drive-tab', 2_000));
    expect((await read('drive-tab'))?.request).toBe('Sign in and check Diagnostics');
    expect(await read('drive-tab-2')).toBeUndefined();
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

/*
 * Persona drive: `reticle_intent` accepted `surface.files: ["src/pages/SavedItems.tsx"]` — the file
 * is `src/views/SavedItems.tsx` — and the Memory page showed the wrong path as the fact's source.
 */
describe('a declared file that does not exist', () => {
  it('is not stored as the source, and the answer says so', async () => {
    const { d, fs } = deps(1_000);
    await fs.mkdir('/repo/src/views');
    await fs.writeFile('/repo/src/views/SavedItems.tsx', 'x');
    const out = (await intentTool?.handler(d, {
      action: 'declare',
      intents: [
        {
          id: 'saved',
          statement: 'Saving adds the order to the top of Saved Items',
          surface: { files: ['src/pages/SavedItems.tsx', 'src/views/SavedItems.tsx'] },
        },
      ],
    })) as { filesNotFound?: string[]; intents?: { surface?: { files?: string[] } }[] };
    expect(out.filesNotFound).toEqual(['src/pages/SavedItems.tsx']);
    expect(out.intents?.[0]?.surface?.files).toEqual(['src/views/SavedItems.tsx']);
  });
});

/*
 * Re-drive (persona 21): Bea's agent declared a fact with nothing to file it under. It landed in
 * "unsorted", the Memory page then warned "an agent cannot find a fact without a subject", and the
 * declare answer had said nothing. The answer asks for it, and declaring again with a route files it.
 */
describe('a fact declared with nothing to file it under', () => {
  type Out = {
    noSubject?: { ids: string[]; fix: string };
    intents?: { subject?: string }[];
  };
  const fact = { id: 'saved', statement: 'Saving adds the order to the top of Saved Items' };

  it('is named in the answer, with how to give it a subject', async () => {
    const { d } = deps(1_000);
    const out = (await intentTool?.handler(d, { action: 'declare', intents: [fact] })) as Out;
    expect(out.noSubject?.ids).toEqual(['saved']);
    expect(out.noSubject?.fix).toContain('surface.route');
  });

  it('is filed under its route once declared again with one', async () => {
    const { d } = deps(1_000);
    await intentTool?.handler(d, { action: 'declare', intents: [fact] });
    const again = (await intentTool?.handler(d, {
      action: 'declare',
      intents: [{ ...fact, surface: { route: '/saved-items' } }],
    })) as Out;
    expect(again.noSubject).toBeUndefined();
    expect(again.intents?.[0]?.subject).toBe('saved-items');
  });
});
