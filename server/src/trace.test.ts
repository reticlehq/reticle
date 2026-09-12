/**
 * The trace exists to answer a question no other signal in this repo answers: for THIS tool call,
 * which internal stages ran, in what order, nested how, and where did the time go.
 *
 * The journal records what the agent did to the app. Telemetry records aggregates. Neither tells
 * somebody working on Reticle which code path produced an answer — which is the thing you need when
 * a flow is slow or a verdict is surprising, and the thing that was reconstructed by hand every time.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import { bindSpanContext, span, spanSync, traceEnabled } from './trace.js';

interface TraceLine {
  event: string;
  span: string;
  ms: number;
  depth: number;
  callId: string;
  ok: boolean;
  [key: string]: unknown;
}

function captureTrace(): { lines: TraceLine[]; restore: () => void } {
  const lines: TraceLine[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    const parsed: unknown = JSON.parse(String(chunk));
    if ('object' === typeof parsed && parsed !== null) lines.push(parsed as TraceLine);
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('trace — off by default', () => {
  beforeEach(() => {
    delete process.env[ReticleEnv.TRACE];
  });

  it('is off unless asked for, because a trace on every tool call is a cost on the hot path', () => {
    expect(traceEnabled()).toBe(false);
  });

  it('emits nothing at all when off, and still returns the value', async () => {
    const cap = captureTrace();
    try {
      await expect(span('anything', {}, () => Promise.resolve(7))).resolves.toBe(7);
      expect(cap.lines).toEqual([]);
    } finally {
      cap.restore();
    }
  });
});

describe('trace — on', () => {
  beforeEach(() => {
    process.env[ReticleEnv.TRACE] = '1';
  });
  afterEach(() => {
    delete process.env[ReticleEnv.TRACE];
  });

  it('records one line per stage, with its duration', async () => {
    const cap = captureTrace();
    try {
      await span('resolve-session', { tool: 'reticle_act' }, () => Promise.resolve('ok'));
      expect(cap.lines).toHaveLength(1);
      const [line] = cap.lines;
      expect(line?.span).toBe('resolve-session');
      expect(line?.tool).toBe('reticle_act');
      expect(line?.ok).toBe(true);
      expect(typeof line?.ms).toBe('number');
    } finally {
      cap.restore();
    }
  });

  /**
   * The whole point. Without a shared call id and a depth, a concurrent daemon's trace is a pile of
   * unrelated lines — several agents are inside runTool at once, so interleaving is the normal case,
   * not the edge one.
   */
  it('nests: stages inside a call share its id and carry their depth', async () => {
    const cap = captureTrace();
    try {
      await span('tool', {}, async () => {
        await span('inner-a', {}, () => Promise.resolve(1));
        await span('inner-b', {}, async () => {
          await span('deepest', {}, () => Promise.resolve(2));
        });
      });
      const byName = new Map(cap.lines.map((l) => [l.span, l]));
      expect([...byName.keys()].sort()).toEqual(['deepest', 'inner-a', 'inner-b', 'tool']);
      const ids = new Set(cap.lines.map((l) => l.callId));
      expect(ids.size, 'one call id for the whole tree').toBe(1);
      expect(byName.get('tool')?.depth).toBe(0);
      expect(byName.get('inner-a')?.depth).toBe(1);
      expect(byName.get('deepest')?.depth).toBe(2);
    } finally {
      cap.restore();
    }
  });

  /**
   * The e2e battery runs many daemons and a restarted one starts its counter over, so a bare `c7`
   * named a different call in every process — and aggregating that trace merges unrelated calls
   * into one. Found on the first real trace collected.
   */
  it('qualifies the call id with the pid, so two daemons never claim the same id', async () => {
    const cap = captureTrace();
    try {
      await span('tool', {}, () => Promise.resolve(0));
      expect(cap.lines[0]?.callId).toContain(`p${String(process.pid)}-`);
    } finally {
      cap.restore();
    }
  });

  it('gives concurrent calls different ids, so their stages never mix', async () => {
    const cap = captureTrace();
    try {
      await Promise.all([
        span('call', {}, () => span('inner', { which: 'a' }, () => Promise.resolve(0))),
        span('call', {}, () => span('inner', { which: 'b' }, () => Promise.resolve(0))),
      ]);
      const ids = new Set(cap.lines.map((l) => l.callId));
      expect(ids.size).toBe(2);
      for (const id of ids) {
        // Only the inner spans carry `which` — the root does not, and counting its `undefined`
        // as a value would make this assert something other than what it says.
        const marks = cap.lines.filter((l) => l.callId === id && l.which !== undefined);
        expect(marks.length, 'each call has its own inner stage').toBe(1);
        expect(new Set(marks.map((l) => l.which)).size, 'a tree never mixes two calls').toBe(1);
      }
    } finally {
      cap.restore();
    }
  });

  /**
   * `reticle init` — the flow every user hits before anything else — is entirely synchronous, so an
   * async-only span could not reach it. That left the one flow whose slowness a user experiences
   * personally as the one flow with no timings at all.
   */
  it('traces a synchronous stage, and nests it under an async parent', async () => {
    const cap = captureTrace();
    try {
      await span('init', {}, () => {
        const wrote = spanSync('write-config', { target: '.reticle.json' }, () => 'written');
        expect(wrote).toBe('written');
      });
      const byName = new Map(cap.lines.map((l) => [l.span, l]));
      expect(byName.get('write-config')?.depth).toBe(1);
      expect(byName.get('write-config')?.target).toBe('.reticle.json');
      expect(new Set(cap.lines.map((l) => l.callId)).size, 'one tree').toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('records a synchronous stage that threw, and re-throws it unchanged', () => {
    const cap = captureTrace();
    try {
      expect(() =>
        spanSync('failing-sync', {}, () => {
          throw new Error('sync boom');
        }),
      ).toThrow('sync boom');
      expect(cap.lines[0]?.ok).toBe(false);
      expect(cap.lines[0]?.error).toContain('sync boom');
    } finally {
      cap.restore();
    }
  });

  /**
   * A stage that THREW is the one you most want in the trace. Swallowing the line there would leave
   * the trace showing a call that entered a stage and never left it — which reads as a hang.
   */
  it('records a stage that threw, and re-throws it unchanged', async () => {
    const cap = captureTrace();
    const boom = new Error('kaboom');
    try {
      await expect(span('failing', {}, () => Promise.reject(boom))).rejects.toThrow('kaboom');
      expect(cap.lines).toHaveLength(1);
      expect(cap.lines[0]?.ok).toBe(false);
      expect(cap.lines[0]?.error).toContain('kaboom');
    } finally {
      cap.restore();
    }
  });
});

/**
 * A callback that runs OUTSIDE the call's async chain must still belong to that call.
 *
 * `waitForPredicate` re-checks its predicate from two places that are not in the awaited chain: a
 * WebSocket event listener and an interval. AsyncLocalStorage does not reach either, so every
 * re-check opened a BRAND NEW call at depth 0. Measured on one healthy bench-app run: 165 spans
 * across 60 callIds, of which 25 were `browser.command` with no matching `tool.handler` — all of
 * them poll traffic from waits that completed perfectly normally.
 *
 * That is not merely untidy. The documented signature of a HUNG tool call is exactly "a
 * browser.command with no tool.handler for that callId, ever" — the invariant that located the
 * act_and_wait hang. A clean run producing 23 of them makes the invariant unusable and buries a real
 * hang in noise.
 */
describe('bindSpanContext — work dispatched outside the async chain stays in its call', () => {
  beforeEach(() => {
    process.env[ReticleEnv.TRACE] = '1';
  });
  afterEach(() => {
    delete process.env[ReticleEnv.TRACE];
  });

  it('keeps a later callback in the SAME call, one level deeper', async () => {
    const cap = captureTrace();
    let later: (() => void) | undefined;
    await span('tool.handler', {}, () => {
      later = bindSpanContext(() => {
        spanSync('browser.command', { command: 'match' }, () => undefined);
      });
    });
    // Fired after the handler resolved, exactly as the event listener and interval do.
    later?.();
    cap.restore();
    const handler = cap.lines.find((l) => 'tool.handler' === l.span);
    const command = cap.lines.find((l) => 'browser.command' === l.span);
    expect(handler?.callId, 'the handler must have a call id').toBeDefined();
    expect(command?.callId, 'the poll must belong to the SAME call').toBe(handler?.callId);
    expect(command?.depth, 'and sit inside it, not beside it').toBe(1);
  });

  it('does not invent a call when there was no span to bind to', () => {
    const cap = captureTrace();
    bindSpanContext(() => {
      spanSync('browser.command', { command: 'match' }, () => undefined);
    })();
    cap.restore();
    // Still traced, still correlatable on its own — just parentless, which is the honest answer.
    expect(cap.lines.find((l) => 'browser.command' === l.span)?.depth).toBe(0);
  });

  it('passes arguments through untouched', () => {
    const seen: unknown[] = [];
    bindSpanContext((...args: unknown[]) => seen.push(...args))(1, 'two');
    expect(seen).toEqual([1, 'two']);
  });
});
