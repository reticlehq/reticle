/**
 * A value the caps mangled must never be compared as if it were the value.
 *
 * Found by driving the Atlas fixture. Clicking Dispatch and asserting
 * `{kind:'state', path:'pendingDispatch', equals:{$contains:'shp_000001'}}` returned:
 *
 *   verified: "no"
 *   failureReason: state 'pendingDispatch' is "[TRUNCATED]", expected {"$contains":"shp_000001"}
 *
 * while the same response body carried `pendingDispatch: [] -> ["shp_000001"]` in its state diffs.
 * The assertion was TRUE. The predicate compared `{$contains:'shp_000001'}` against the literal
 * string `"[TRUNCATED]"`, which of course does not match, and reported a confident `no`.
 *
 * That is the damaging direction of error. A false green is a missed catch; a false accusation sends
 * someone to fix an application that did exactly what it was told, and it is how the instrument
 * stops being believed. The repo already made this argument once for `response-ignored`.
 *
 * There are two defects stacked here and both are fixed:
 *
 *  1. **It read the wrong way.** `evalState` always asked for EVERY store and walked the path
 *     itself, so a big store hit the transport cap before the path was ever selected. The browser
 *     has a scoped read that walks the RAW uncapped store first, added for exactly this reason
 *     ("selecting before the transport cap is what lets a deep/large path resolve"). The predicate
 *     was not using it. Atlas's `pendingDispatch` is a one-element array — nothing about the value
 *     being asserted was large. It was collateral damage from `rows` sitting beside it.
 *
 *  2. **It trusted the result anyway.** Even a scoped read can hit the caps when the selected
 *     sub-tree is itself large, and `readState` says so in a `truncation` field that nothing on this
 *     path ever read. A comparison against a value known to be incomplete is not a failure, it is an
 *     unanswered question, and the verdict layer already knows how to report those.
 *
 * The re-read is paid only when truncation actually fired, so an intact read costs exactly what it
 * did before.
 */

import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate } from './predicate.js';
import type { PredicateSession } from './predicate.js';

interface Reply {
  stores?: Record<string, unknown>;
  storeNames?: string[];
  truncation?: Record<string, unknown>;
  found?: boolean;
  value?: unknown;
  store?: string;
  path?: string;
}

/** Records every STATE_READ so the test can assert HOW the value was fetched, not just the verdict. */
class StateSession implements PredicateSession {
  readonly reads: Record<string, unknown>[] = [];
  constructor(private readonly reply: (args: Record<string, unknown>) => Reply) {}
  elapsed(): number {
    return 0;
  }
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult> {
    if (name === ReticleCommand.STATE_READ) {
      const a = args ?? {};
      this.reads.push(a);
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: this.reply(a) });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

/** Atlas's real shape: the asserted value is tiny, the store beside it is what blew the cap. */
const TRUNCATED_WHOLE: Reply = {
  stores: { atlas: { rows: '[TRUNCATED]', pendingDispatch: '[TRUNCATED]' } },
  storeNames: ['atlas'],
  truncation: { truncatedValues: 2, droppedItems: 0, note: 'caps fired' },
};

describe('a truncated state read never produces a confident verdict', () => {
  it('re-reads the path directly when the whole-store read was capped, and then passes', () => {
    // The scoped read walks the raw store, so the one-element array survives and the assertion that
    // was always true is reported as true.
    const session = new StateSession((args) =>
      args['path'] === undefined
        ? TRUNCATED_WHOLE
        : { store: 'atlas', path: 'pendingDispatch', found: true, value: ['shp_000001'] },
    );
    return evaluatePredicate(session, {
      kind: 'state',
      path: 'pendingDispatch',
      equals: { $contains: 'shp_000001' },
    }).then((r) => {
      expect(r.pass).toBe(true);
      expect(session.reads.some((a) => 'pendingDispatch' === a['path'])).toBe(true);
    });
  });

  it('is INCONCLUSIVE, not a failure, when even the scoped re-read is truncated', async () => {
    // The safety net. A comparison against a value known to be incomplete is an unanswered question,
    // and `no` would be an accusation the evidence does not support.
    const session = new StateSession(() => ({
      ...TRUNCATED_WHOLE,
      found: true,
      value: '[TRUNCATED]',
      truncation: { truncatedValues: 1, droppedItems: 0, note: 'caps fired' },
    }));
    const r = await evaluatePredicate(session, {
      kind: 'state',
      store: 'atlas',
      path: 'pendingDispatch',
      equals: { $contains: 'shp_000001' },
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.inconclusive).toContain('truncat');
  });

  it('does not spend a second round trip when nothing was truncated', async () => {
    // The common case has to stay exactly as cheap as it was.
    const session = new StateSession(() => ({
      stores: { atlas: { view: 'deployments' } },
      storeNames: ['atlas'],
    }));
    const r = await evaluatePredicate(session, {
      kind: 'state',
      path: 'view',
      equals: 'deployments',
    });
    expect(r.pass).toBe(true);
    expect(session.reads).toHaveLength(1);
  });

  it('still reports a genuine mismatch as a failure, not as truncation', async () => {
    // The fix must not turn every red into an `unknown`.
    const session = new StateSession(() => ({
      stores: { atlas: { view: 'overview' } },
      storeNames: ['atlas'],
    }));
    const r = await evaluatePredicate(session, {
      kind: 'state',
      path: 'view',
      equals: 'deployments',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('state.equals');
  });
});
