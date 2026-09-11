import { describe, expect, it } from 'vitest';
import { measurementVerdict } from './pass-artifact.mjs';

/**
 * The guard that decides whether a pass MEASURED anything used to read `data.rows`, and eight of the
 * twelve passes do not write a `rows` array. Those eight were unguarded: a pass whose every flow
 * errored still wrote a plausible-looking artifact of nulls, exited 0, and was ticked green.
 *
 * The shapes below are the real ones, one per family, so a pass that invents a new shape is caught
 * by the token rule rather than silently exempted from the guard.
 */

const errored = { error: 'mcp process exited code=1' };

describe('measurementVerdict', () => {
  it('passes a rows artifact with at least one measured row', () => {
    expect(measurementVerdict({ rows: [errored, { tokens: 180 }] }).ok).toBe(true);
  });

  it('fails a rows artifact whose rows all errored, and quotes the first error', () => {
    const v = measurementVerdict({ rows: [errored, errored] });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('mcp process exited');
  });

  it('fails an empty rows artifact', () => {
    expect(measurementVerdict({ rows: [] }).ok).toBe(false);
  });

  /** The observation pass writes a TOP-LEVEL array — the most expensive pass in the suite. */
  it('reads a top-level array as the rows', () => {
    expect(measurementVerdict([{ tokens_o200k: 806 }]).ok).toBe(true);
    expect(measurementVerdict([]).ok).toBe(false);
    expect(measurementVerdict([{ tokens_o200k: null }, { tokens_o200k: null }]).ok).toBe(false);
  });

  /** The suite-scale pass writes `points`. */
  it('reads points as the rows', () => {
    expect(measurementVerdict({ points: [{ reticle_verify_tokens: 320 }] }).ok).toBe(true);
    expect(measurementVerdict({ points: [] }).ok).toBe(false);
  });

  /** The four consequence-oracle passes and the determinism pass write scalars only. */
  it('passes a scalar artifact that recorded a token measurement', () => {
    expect(measurementVerdict({ detected: true, per_run_tokens: 214 }).ok).toBe(true);
    expect(measurementVerdict({ runs: 5, per_run_tokens: [214, 214] }).ok).toBe(true);
  });

  it('fails a scalar artifact whose measurements are all null or zero', () => {
    const v = measurementVerdict({ detected: false, per_run_tokens: null });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('token');
    expect(measurementVerdict({ runs: 0, per_run_tokens: [0, 0] }).ok).toBe(false);
  });

  /**
   * The competitor re-drive figures are CONSTANTS written into every artifact — measured once, by
   * hand, and never re-measured. A pass that measured nothing still carries them, so counting them
   * as evidence would leave the guard inert exactly where it was already inert.
   */
  it('does not accept a competitor constant as evidence that this run measured anything', () => {
    const v = measurementVerdict({
      per_run: {
        reticle_replay_mean_tokens: null,
        playwright_mcp_redrive_tokens: 30249,
        chrome_devtools_mcp_redrive_tokens: 12000,
      },
      rows: [errored],
    });
    expect(v.ok).toBe(false);
  });

  it('accepts a measurement of our own beside those constants', () => {
    const v = measurementVerdict({
      per_run: { reticle_replay_mean_tokens: 237, playwright_mcp_redrive_tokens: 30249 },
      rows: [{ tokens: 237 }],
    });
    expect(v.ok).toBe(true);
  });

  /** The analysis artifact is per-tool aggregates — no rows anywhere. */
  it('reads the per-tool aggregate shape', () => {
    expect(measurementVerdict({ per_tool: { reticle: { avg_tokens_o200k: 806 } } }).ok).toBe(true);
    expect(measurementVerdict({ per_tool: { reticle: { avg_tokens_o200k: null } } }).ok).toBe(
      false,
    );
  });

  it('fails an artifact that is not an object at all', () => {
    expect(measurementVerdict(null).ok).toBe(false);
    expect(measurementVerdict(7).ok).toBe(false);
  });
});
