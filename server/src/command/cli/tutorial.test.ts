import { describe, it, expect } from 'vitest';
import {
  tutorialScript,
  tutorialNextSteps,
  renderTutorial,
  installClosing,
  TutorialAudience,
} from './tutorial.js';

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

/**
 * Every other stage of setup hands the reader the next command: `install.sh` closes with
 * `reticle init` and `reticle tutorial`, and `init` closes with the dev server and `status`. The
 * tutorial closed with step 4 and nothing at all — the one stage whose whole job is to teach the
 * sequence was the one that did not say what to do with it. A reader who has just been told a
 * verdict is the point, and is then shown no way to produce one, is exactly where a funnel stalls.
 */
describe('the tour says what to do when it ends', () => {
  it('closes with a next step, for both audiences', () => {
    for (const audience of [TutorialAudience.HUMAN, TutorialAudience.AGENT]) {
      expect(tutorialNextSteps(audience), `${audience} was left with nothing to do`).not.toBe('');
    }
  });

  it('names the command that instruments a project, which is what the reader still lacks', () => {
    expect(tutorialNextSteps(TutorialAudience.HUMAN)).toContain('reticle init');
  });

  it('renders that closing block, so it is not merely available to callers', () => {
    expect(renderTutorial(TutorialAudience.HUMAN)).toContain('reticle init');
  });
});

/**
 * The tour was a command nobody was told to run twice.
 *
 * `setup install` named it in one line — `reticle tutorial  # what Reticle is, in two minutes` —
 * and `reticle init` never mentioned it at all. So unless somebody read that line and chose to
 * type it, the ONBOARD phase never happened and they went straight from Installation to First run.
 * The funnel would have recorded `tour_started` at roughly zero and read as "nobody wants the
 * tour", when in fact nobody was shown one.
 *
 * Showing it depends on whether a HUMAN is watching. The installer's rule is zero human input,
 * because the common case is an agent following a pasted link; twenty-five lines of prose into a
 * pipe helps nobody. A TTY is the honest signal for which of the two is reading.
 */
describe('the installer shows the tour to a person and names it to a pipe', () => {
  it('prints the whole tour when somebody is watching', () => {
    const shown = installClosing(true);
    expect(shown).toContain('Take a semantic snapshot');
    expect(shown).toContain('Reticle is installed');
  });

  it('does not then tell them to go and run the thing they just read', () => {
    expect(installClosing(true)).not.toContain('reticle tutorial');
  });

  it('keeps the terse pointer when the output is piped', () => {
    const piped = installClosing(false);
    expect(piped).toContain('reticle tutorial');
    expect(piped).not.toContain('Take a semantic snapshot');
  });

  // Whichever branch, the reader must leave knowing the one command that comes next.
  it('names `reticle init` either way', () => {
    for (const tty of [true, false]) {
      expect(installClosing(tty), `tty=${String(tty)}`).toContain('reticle init');
    }
  });
});
