import { describe, expect, it } from 'vitest';
import {
  EventType,
  JOURNAL_FILE_VERSION,
  RUN_ESTABLISHED_CAP,
  Verified,
  type JournalAction,
  type ReticleEvent,
  type RunContext,
} from '@reticlehq/core';
import { createMemoryFs } from '../project/memory-fs.js';
import { IntentStore } from '../intent/intent-store.js';
import { CONTEXT_TOOLS } from './context-tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import type { FileSystemPort } from '../project/fs-port.js';
import type { ToolDeps } from '../tools/tool-kit.js';

const ROOT = '/repo/.reticle';

const tool = () => {
  const found = CONTEXT_TOOLS.find((t) => ReticleTool.CONTEXT === t.name);
  if (undefined === found) throw new Error('reticle_context must be in CONTEXT_TOOLS');
  return found;
};

function action(over: Partial<JournalAction> = {}): JournalAction {
  return {
    v: JOURNAL_FILE_VERSION,
    actionId: 'c1',
    tool: 'reticle_act_and_wait',
    args: { ref: 'e12', action: 'click' },
    tRange: { from: 0, to: 10 },
    at: 0,
    ...over,
  };
}

function event(over: Partial<ReticleEvent> = {}): ReticleEvent {
  return { t: 0, type: EventType.DOM_ADDED, data: {}, ...over } as ReticleEvent;
}

interface Fake {
  actions?: JournalAction[];
  events?: ReticleEvent[];
  documentId?: string;
  editEpoch?: number;
  connected?: boolean;
}

function deps(fs: FileSystemPort, fake: Fake = {}): ToolDeps {
  const session = {
    readJournalActions: (): Promise<JournalAction[]> => Promise.resolve(fake.actions ?? []),
    queryEvents: (): Promise<ReticleEvent[]> => Promise.resolve(fake.events ?? []),
    currentDocumentId: fake.documentId,
    currentEditEpoch: fake.editEpoch,
  };
  return {
    sessions: {
      resolve: () => {
        if (false === fake.connected) throw new Error('no session is connected');
        return session;
      },
    },
    fs,
    reticleRoot: ROOT,
    now: () => 1_000,
  } as unknown as ToolDeps;
}

const call = async (fs: FileSystemPort, fake: Fake = {}): Promise<RunContext> =>
  (await tool().handler(deps(fs, fake), {})) as RunContext;

describe('reticle_context', () => {
  it('returns the established facts, folded and capped', async () => {
    const { fs } = createMemoryFs();
    const many = Array.from({ length: RUN_ESTABLISHED_CAP + 6 }, (_, i) =>
      action({
        actionId: `c${String(i)}`,
        args: { ref: `e${String(i)}`, action: 'click' },
        settled: true,
      }),
    );
    const context = await call(fs, { actions: many });
    expect(context.established.length).toBeLessThanOrEqual(RUN_ESTABLISHED_CAP);
    expect(context.step).toBe(many.length);
  });

  it('omits a fact established under a document that has been replaced', async () => {
    const { fs } = createMemoryFs();
    const context = await call(fs, {
      actions: [action({ settled: true })],
      events: [event({ actionId: 'c1', documentId: 'doc00001' })],
      documentId: 'doc00002',
    });
    expect(context.established).toEqual([]);
  });

  it('omits a fact established under a pre-edit epoch', async () => {
    const { fs } = createMemoryFs();
    const context = await call(fs, {
      actions: [action({ settled: true })],
      events: [event({ actionId: 'c1', documentId: 'doc00001', editEpoch: 1 })],
      documentId: 'doc00001',
      editEpoch: 2,
    });
    expect(context.established).toEqual([]);
  });

  it('lists the intents no verdict has discharged', async () => {
    const { fs } = createMemoryFs();
    await new IntentStore(fs, ROOT, { now: () => 1 }).declare([
      { id: 'checkin', statement: 'the badge reads checked in' },
    ]);
    expect((await call(fs)).remaining).toEqual(['the badge reads checked in']);
  });

  it('lists what a verdict already proved, so it is neither re-proved nor assumed', async () => {
    const { fs } = createMemoryFs();
    const context = await call(fs, {
      actions: [
        action({
          settled: true,
          effect: { claim: 'the badge reads checked in', verified: Verified.YES },
        }),
      ],
    });
    expect(context.proven).toEqual([
      {
        claim: 'the badge reads checked in',
        verified: Verified.YES,
        source: undefined,
        doc: undefined,
        epoch: undefined,
      },
    ]);
  });

  it('answers a fresh session honestly empty rather than inventing a run', async () => {
    const { fs } = createMemoryFs();
    expect(await call(fs, { connected: false })).toEqual({
      step: 0,
      established: [],
      proven: [],
      remaining: [],
    });
  });
});
