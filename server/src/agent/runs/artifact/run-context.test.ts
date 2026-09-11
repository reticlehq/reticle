import { describe, expect, it } from 'vitest';
import {
  EventType,
  JOURNAL_FILE_VERSION,
  RUN_ESTABLISHED_CAP,
  Verified,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import { establishedFromJournal, provenFromJournal, runContextFor } from './run-context.js';

function action(over: Partial<JournalAction> = {}): JournalAction {
  return {
    v: JOURNAL_FILE_VERSION,
    actionId: 'c1',
    tool: 'reticle_act',
    args: { ref: 'e12', action: 'click' },
    tRange: { from: 0, to: 10 },
    at: 0,
    ...over,
  };
}

function event(over: Partial<ReticleEvent> = {}): ReticleEvent {
  return { t: 0, type: EventType.DOM_ADDED, data: {}, ...over } as ReticleEvent;
}

describe('establishedFromJournal — only what Reticle observed', () => {
  it('keys a settled action on its ref, so re-driving it supersedes', () => {
    const facts = establishedFromJournal([action({ settled: true })], []);
    expect(facts[0]?.key).toBe('e12');
    expect(facts[0]?.fact).toBe('click settled');
  });

  it('records an action that did NOT settle rather than dropping it', () => {
    expect(establishedFromJournal([action({ settled: false })], [])[0]?.fact).toBe(
      'click did not settle',
    );
  });

  it('says nothing about an action whose settle outcome was never observed', () => {
    expect(establishedFromJournal([action()], [])).toEqual([]);
  });

  it('falls back to the target text when the call named no ref', () => {
    const facts = establishedFromJournal(
      [action({ args: { target: 'Submit', action: 'click' }, settled: true })],
      [],
    );
    expect(facts[0]?.key).toBe('Submit');
  });

  it('stamps the document and the edit epoch the action was observed under', () => {
    const facts = establishedFromJournal(
      [action({ settled: true })],
      [event({ actionId: 'c1', documentId: 'doc00001', editEpoch: 3 })],
    );
    expect(facts[0]?.doc).toBe('doc00001');
    expect(facts[0]?.epoch).toBe(3);
  });

  it('carries the source pointer the verdict already reported', () => {
    const facts = establishedFromJournal(
      [
        action({
          settled: true,
          effect: {
            claim: 'the badge reads checked in',
            verified: Verified.YES,
            source: 'a.tsx:9',
          },
        }),
      ],
      [],
    );
    expect(facts[0]?.source).toBe('a.tsx:9');
  });

  it('files the route under one stable key so only the newest survives', () => {
    const facts = establishedFromJournal(
      [],
      [
        event({ type: EventType.ROUTE_CHANGE, data: { pathname: '/a' } }),
        event({ t: 1, type: EventType.ROUTE_CHANGE, data: { pathname: '/b' } }),
      ],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toBe('route is /b');
  });

  it('never reads further back than the fold can keep', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      action({
        actionId: `c${String(i)}`,
        args: { ref: `e${String(i)}`, action: 'click' },
        settled: true,
      }),
    );
    const facts = establishedFromJournal(many, []);
    expect(facts.length).toBeLessThanOrEqual(RUN_ESTABLISHED_CAP);
    expect(facts.at(-1)?.key).toBe('e39');
  });
});

describe('provenFromJournal — what a verdict already settled', () => {
  it('reads the claim and the verdict off the action a verification tool recorded', () => {
    const proven = provenFromJournal(
      [
        action({
          tool: 'reticle_act_and_wait',
          effect: { claim: 'the badge reads checked in', verified: Verified.YES },
        }),
      ],
      [event({ actionId: 'c1', documentId: 'doc00001', editEpoch: 2 })],
    );
    expect(proven).toEqual([
      {
        claim: 'the badge reads checked in',
        verified: Verified.YES,
        source: undefined,
        doc: 'doc00001',
        epoch: 2,
      },
    ]);
  });

  it('ignores an action that recorded no verdict, rather than inventing one', () => {
    expect(provenFromJournal([action({ settled: true })], [])).toEqual([]);
  });
});

describe('runContextFor', () => {
  it('drops a fact from a document that has been replaced', () => {
    const context = runContextFor({
      actions: [action({ settled: true })],
      events: [event({ actionId: 'c1', documentId: 'doc00001' })],
      intents: [],
      currentDocumentId: 'doc00002',
      currentEditEpoch: undefined,
    });
    expect(context.established).toEqual([]);
  });

  it('drops a fact and a proof from a pre-edit epoch', () => {
    const context = runContextFor({
      actions: [
        action({
          settled: true,
          effect: { claim: 'the badge reads checked in', verified: Verified.YES },
        }),
      ],
      events: [event({ actionId: 'c1', documentId: 'doc00001', editEpoch: 1 })],
      intents: [],
      currentDocumentId: 'doc00001',
      currentEditEpoch: 2,
    });
    expect(context.established).toEqual([]);
    expect(context.proven).toEqual([]);
  });

  it('counts the step off the journal rather than a counter of its own', () => {
    const context = runContextFor({
      actions: [action({ settled: true }), action({ actionId: 'c2', settled: true })],
      events: [],
      intents: [],
      currentDocumentId: undefined,
      currentEditEpoch: undefined,
    });
    expect(context.step).toBe(2);
  });

  it('answers a fresh run with an honest empty context', () => {
    expect(
      runContextFor({
        actions: [],
        events: [],
        intents: [],
        currentDocumentId: undefined,
        currentEditEpoch: undefined,
      }),
    ).toEqual({ step: 0, established: [], proven: [], remaining: [] });
  });
});
