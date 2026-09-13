import { describe, it, expect } from 'vitest';
import { tutorialScript, TutorialAudience } from './tutorial.js';

/**
 * Two audiences, one truth.
 *
 * A human reading a tutorial wants to know what to DO next and why it is worth doing. An agent
 * wants the exact call and the exact shape of the answer, because prose it has to interpret is a
 * turn it has to spend. Writing one and hoping the other copes is how a "getting started" page
 * becomes something agents skip and humans skim.
 *
 * The one thing both must share is the SEQUENCE. Two audiences following different orders through
 * the same product is how a support answer stops matching what anybody actually did.
 */
describe('tutorialScript', () => {
  it('gives a human prose and a reason, never a bare command', () => {
    for (const step of tutorialScript(TutorialAudience.HUMAN)) {
      expect(step.say.length, step.id).toBeGreaterThan(20);
      expect(step.why, step.id).toBeTruthy();
    }
  });

  it('gives an agent an exact call it can make without interpreting prose', () => {
    for (const step of tutorialScript(TutorialAudience.AGENT)) {
      expect(step.call, step.id).toBeTruthy();
    }
  });

  it('walks BOTH audiences through the same steps in the same order', () => {
    const human = tutorialScript(TutorialAudience.HUMAN).map((s) => s.id);
    const agent = tutorialScript(TutorialAudience.AGENT).map((s) => s.id);
    expect(agent).toEqual(human);
  });

  it('ends at a VERDICT, because anything short of one has taught nothing', () => {
    const last = tutorialScript(TutorialAudience.AGENT).at(-1);
    expect(last?.id).toBe('verdict');
  });

  it('reaches a verdict through act_and_wait, the only ordinary path that produces one', () => {
    const calls = tutorialScript(TutorialAudience.AGENT)
      .map((s) => s.call ?? '')
      .join(' ');
    expect(calls).toContain('reticle_act_and_wait');
  });

  it('teaches the consequence BEFORE the action — that is the whole idea being taught', () => {
    const steps = tutorialScript(TutorialAudience.AGENT);
    const declare = steps.findIndex((s) => 'declare' === s.id);
    const verdict = steps.findIndex((s) => 'verdict' === s.id);
    expect(declare).toBeGreaterThanOrEqual(0);
    expect(declare).toBeLessThan(verdict);
  });
});
