import { describe, expect, it } from 'vitest';
import { liveCallText } from './live-call-text.js';
import { ReticleTool } from '@reticlehq/core';

/**
 * Guidance that names a tool the reader was not given.
 *
 * MEASURED on the nine-tool surface, driving it over a real MCP client: three separate pieces of
 * advice routed the agent to `reticle_run` or `reticle_lease`, neither of which that surface
 * advertises — including the no-session diagnosis, which is the FIRST text an agent reads and the
 * one shown when nothing is connected yet. Its `NEXT ACTION` was a dead end with no alternative
 * given, and the command-timeout recovery went further and explained that `reticle_lease` "is
 * reached through reticle_run, not called directly" — a specific, confident instruction to call a
 * tool the same surface removes by name.
 *
 * `surface-vocabulary.ts` already solved this for the briefing, and its own header says a briefing
 * naming a tool the agent lacks should be "unrepresentable rather than merely tested for". That
 * reasoning was never applied to the text attached to RESULTS, which is where an agent reads most
 * of its advice and all of it under failure.
 */
const MERGED = new Set<string>([
  ReticleTool.NAVIGATE,
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.LOOK,
  ReticleTool.OBSERVE,
  ReticleTool.ASSERT,
  ReticleTool.SESSION,
  ReticleTool.VERIFY,
]);
/** A surface that really does advertise the dispatch hatch: nothing should be rewritten. */
const FULL = new Set<string>([...MERGED, ReticleTool.RUN, ReticleTool.LEASE, ReticleTool.SESSIONS]);

describe('advice names a call the reader can actually make', () => {
  it('rewrites a merged name to the call that replaced it', () => {
    expect(liveCallText('Call reticle_sessions to list them.', MERGED)).toBe(
      'Call reticle_session { action: "list" } to list them.',
    );
  });

  it('leaves a name the surface really advertises alone', () => {
    const text = 'Call reticle_sessions to list them.';
    expect(liveCallText(text, FULL)).toBe(text);
  });

  it('replaces the lease escape hatch with one that exists when neither tool is advertised', () => {
    const out = liveCallText(
      'drive your own browser with reticle_run { tool: "reticle_lease", action: "acquire", url }',
      MERGED,
    );
    expect(out).not.toContain('reticle_run');
    expect(out).not.toContain('reticle_lease');
    // The CLI is the escape hatch that survives on every surface, because it is not a tool.
    expect(out).toContain('reticle open');
  });

  it('keeps the lease advice verbatim where the tools exist', () => {
    const text =
      'drive your own browser with reticle_run { tool: "reticle_lease", action: "acquire", url }';
    expect(liveCallText(text, FULL)).toBe(text);
  });

  it('rewrites the ESCAPED form, which is the one that actually ships', () => {
    // The rewrite runs over the serialised payload, so this is the shape it really meets. The first
    // implementation handled only unescaped quotes: every unit test passed and the live daemon was
    // unchanged.
    const serialised = JSON.stringify({
      recovery:
        'drive your own browser with reticle_run { tool: "reticle_lease", action: "acquire", url }',
    });
    const out = liveCallText(serialised, MERGED);
    expect(out).not.toContain('reticle_run');
    expect(out).not.toContain('reticle_lease');
    const parsed = JSON.parse(out) as { recovery: string };
    expect(parsed.recovery).toContain('reticle open');
  });

  it('redirects flow management on a surface that has no flow tool and no CLI for it', () => {
    const out = liveCallText('run reticle_flow{action:"list"} to see saved flows', MERGED);
    expect(out).not.toContain('reticle_flow{');
    expect(out).toContain('reticle_verify { action: "flows" }');
  });

  it('leaves text naming no tool untouched', () => {
    const text = 'The page did not answer within the command window.';
    expect(liveCallText(text, MERGED)).toBe(text);
  });

  it('rewrites every occurrence, not just the first', () => {
    const out = liveCallText('reticle_sessions then reticle_sessions again', MERGED);
    expect(out).not.toContain('reticle_sessions');
  });
});
