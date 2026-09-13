import { describe, it, expect } from 'vitest';
import { perturbationFor } from './flow-mutation-target.js';

/**
 * Everyone chases determinism to make a run repeatable. This inverts it: inject non-determinism ON
 * PURPOSE, seeded, so the chaos is repeatable too.
 *
 * Races, double-submits, stale-response-applied and debounce failures do not appear on a fast local
 * machine. They appear when something is slow, reordered or hurried — and the harness prompt already
 * knew it: *"an app that handles them one at a time and an app that races them look identical until
 * someone hurries."* Until now there was no engine behind that sentence.
 *
 * The whole value rests on REPRODUCIBILITY. A race caught by chaos nobody can re-run is a rumour, so
 * the same seed must produce the same perturbation, forever, on any machine.
 */
describe('perturbationFor', () => {
  const targets = ['/api/save', '/api/load', '/api/audit'];

  it('is deterministic — the same seed gives byte-identical rules', () => {
    expect(perturbationFor(42, targets)).toEqual(perturbationFor(42, targets));
  });

  it('different seeds explore different interleavings', () => {
    const a = JSON.stringify(perturbationFor(1, targets));
    const b = JSON.stringify(perturbationFor(2, targets));
    expect(a).not.toBe(b);
  });

  it('only ever perturbs endpoints the flow DECLARED it depends on', () => {
    for (const rule of perturbationFor(7, targets)) {
      expect(targets).toContain(rule.urlContains);
    }
  });

  it('delays rather than breaks — a perturbation is a race, not a fault', () => {
    // `request-fails` is mutation testing's job and answers a different question. Chaos asks whether
    // the app is correct when the world is SLOW, so a rule that aborted would be measuring the other
    // thing and calling it this one.
    // The TYPE already makes `abort`/`status` unrepresentable here, which is the stronger guarantee.
    // This pins the other half: nothing extra is smuggled in at runtime either, so a rule can only
    // ever say WHEN — never WHAT — and the app races the server's own answer.
    for (const rule of perturbationFor(9, targets)) {
      expect(Object.keys(rule).sort()).toEqual(['delayMs', 'urlContains']);
      expect(rule.delayMs).toBeGreaterThan(0);
    }
  });

  it('perturbs at least one endpoint, or the run is a clean replay wearing a seed', () => {
    expect(perturbationFor(3, targets).length).toBeGreaterThan(0);
  });

  it('declares nothing to do when the flow named no endpoints', () => {
    expect(perturbationFor(3, [])).toEqual([]);
  });

  it('spreads delays so responses can arrive out of RECORDED order', () => {
    // One uniform delay slows everything equally and reorders nothing — the app never races. The
    // point is a spread, so a later request can beat an earlier one home.
    const delays = perturbationFor(5, targets).map((r) => r.delayMs);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });
});
