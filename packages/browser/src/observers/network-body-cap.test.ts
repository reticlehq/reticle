/**
 * The per-body capture cap is raisable, and raising it does not reintroduce the freeze (#799).
 *
 * The default cap makes exactly one assertion class impossible: a NEGATIVE `bodyContains` has to be
 * checked over the whole payload, so on a list endpoint larger than 8 KB it is permanently
 * undecidable — and that is the class that proves safety invariants. Positive assertions degrade
 * gracefully, because the match is usually early in the body.
 *
 * The cap could not simply be made unbounded, because the scan bound behind it was set by
 * measurement: `redactText` backtracks quadratically (8 KB → 36 ms, 16 KB → 136 ms, 64 KB →
 * 2067 ms). These tests pin the split that lets the cap rise anyway — a JSON body, which takes
 * `JSON.parse` + `safeStringify` and never touches that regex, is scanned to the full configured
 * width; a non-JSON text body stays inside the measured ceiling however high the cap is set.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { projectBody, setNetworkBodyMaxChars, networkBodyMaxChars } from './network-body.js';

const DEFAULT_CAP = 8192;

afterEach(() => {
  setNetworkBodyMaxChars(DEFAULT_CAP);
});

/** A JSON list body of roughly `rows` entries, none of which carries the needle. */
function jsonRows(rows: number): string {
  return JSON.stringify(
    Array.from({ length: rows }, (_, i) => ({
      id: i,
      status: 'manual_review',
      note: 'x'.repeat(40),
    })),
  );
}

describe('the body cap defaults to 8192 and is raisable', () => {
  it('truncates a large JSON body at the default cap', () => {
    const raw = jsonRows(2000);
    expect(raw.length).toBeGreaterThan(DEFAULT_CAP * 4);
    const { body, truncated } = projectBody(raw, 'application/json');
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(DEFAULT_CAP);
  });

  it('keeps the whole body once the cap is raised past it', () => {
    const raw = jsonRows(400);
    setNetworkBodyMaxChars(262144);
    const { body, truncated } = projectBody(raw, 'application/json');
    expect(truncated, 'a body inside the raised cap is complete').toBe(false);
    expect(body.length).toBeGreaterThan(DEFAULT_CAP);
  });

  it('makes a negative assertion decidable that the default cap made undecidable', () => {
    // The reported shape: no row is `"sendable": true`, over a payload larger than the default cap.
    const raw = jsonRows(400);
    expect(raw.length).toBeGreaterThan(DEFAULT_CAP);

    const atDefault = projectBody(raw, 'application/json');
    expect(atDefault.truncated, 'undecidable at the default cap').toBe(true);

    setNetworkBodyMaxChars(262144);
    const raised = projectBody(raw, 'application/json');
    expect(raised.truncated).toBe(false);
    expect(raised.body).not.toContain('"sendable":true');
  });
});

describe('the cap is clamped, not trusted', () => {
  it('clamps above the ceiling', () => {
    setNetworkBodyMaxChars(10_000_000);
    expect(networkBodyMaxChars()).toBe(262144);
  });

  it('clamps below the floor, so a typo cannot silently disable capture', () => {
    setNetworkBodyMaxChars(0);
    expect(networkBodyMaxChars()).toBe(256);
  });

  it('ignores a non-finite value rather than adopting NaN as a length', () => {
    setNetworkBodyMaxChars(Number.NaN);
    expect(networkBodyMaxChars()).toBe(DEFAULT_CAP);
  });
});

describe('raising the cap does not widen the quadratic redaction scan', () => {
  it('never scans a non-JSON body past the measured ceiling, however high the cap', () => {
    // 1 MB of unbroken word characters is the ReDoS shape: `[A-Za-z0-9_.-]+` with no delimiter.
    const raw = 'a'.repeat(1_000_000);
    setNetworkBodyMaxChars(262144);

    const started = Date.now();
    const { body, truncated } = projectBody(raw, 'text/plain');
    const elapsed = Date.now() - started;

    expect(truncated, 'the input was clipped, so the body is not complete').toBe(true);
    // The scan ceiling is 2x the DEFAULT cap, not 2x the configured one, so the output cannot
    // exceed what that scan produced -- which is the property that keeps the cost bounded.
    expect(body.length).toBeLessThanOrEqual(DEFAULT_CAP * 2);
    expect(elapsed, 'a raised cap must not put seconds of work on the main thread').toBeLessThan(
      1000,
    );
  });

  it('still scans a JSON body to the full configured width', () => {
    const raw = jsonRows(400);
    setNetworkBodyMaxChars(262144);
    expect(projectBody(raw, 'application/json').truncated).toBe(false);
  });
});
