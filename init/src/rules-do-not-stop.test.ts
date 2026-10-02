/**
 * The always-loaded rules must carry the whole sequence, and say not to stop part-way through it.
 *
 * The `/reticle` skill already holds an excellent recovery ladder — six ordered checks, five
 * guards, and the line "stopping to ask is how a verification turn ends with nothing verified".
 * None of it runs unless somebody invokes the slash command, and after `init` nothing does.
 *
 * What IS always loaded is `RULE_BODY`, and it described the parts without ever naming the whole:
 * verify when you change something, start a dev server if none is listening, setup is not finished
 * until a verdict exists. Each true, none of them telling an agent that it is currently half way
 * through a sequence it is expected to finish by itself.
 *
 * That matters most at the one legitimate pause. `init` asks for a client restart, and an agent
 * that comes back has only this file. If it does not say "you were mid-install, resume", the agent
 * reads a wired project, no session, and no instruction — and stops.
 *
 * This does not duplicate the ladder. It names the sequence, says do not stop, and points at the
 * skill for the detail.
 */

import { describe, expect, it } from 'vitest';
import { RULE_BODY } from './project/agent-rules.js';

describe('the sequence is named as a sequence', () => {
  it('says setup is not finished until a verdict exists', () => {
    expect(RULE_BODY).toMatch(/not finished until|is not done until/i);
  });

  it('tells the agent not to stop part way', () => {
    expect(RULE_BODY).toMatch(/do not stop|keep going/i);
  });

  it("says the steps are the agent's own, not the user's", () => {
    expect(RULE_BODY).toMatch(/yours to do|without them|do not ask/i);
  });
});

describe('the block does not teach the restart that is no longer on the path', () => {
  /**
   * This replaces a test that asserted the opposite, and the reason is a change in the product.
   *
   * It used to read: "the restart is real and unavoidable on a first install, so what must not be
   * lost is what to do on the other side of it". That was true when the MCP server was registered
   * from inside the client that then had to reload. The machine step now runs in a terminal BEFORE
   * the client opens, so there is nothing to come back from, and guidance about resuming after a
   * restart teaches a sequence that costs a user their install.
   *
   * It was also, by then, passing for the wrong reason: the phrase it matched had moved into an
   * unrelated sentence about feedback ("then carry on with your task"), so it went green while the
   * paragraph it was written to protect had already been rewritten. A test that survives the removal
   * of its own subject is not evidence, which is why this asserts the ABSENCE instead.
   */
  it('does not tell the agent to pause mid-setup for a client restart', () => {
    const restartPause =
      /(legitimate|one) pause[^.]*restart|restart[^.]*then resume|after the restart/i;
    expect(
      RULE_BODY,
      'the installer registers the MCP server before the client opens, so a mid-setup restart is not a step',
    ).not.toMatch(restartPause);
  });

  it('points at the full ladder rather than repeating it', () => {
    expect(RULE_BODY).toMatch(/\/reticle/);
  });
});

/** The same ceiling, stated once more here — see rules-carry-the-unfinished-job.test.ts for why. */
describe('the every-turn budget still holds', () => {
  it('stays under 8KiB', () => {
    expect(RULE_BODY.length).toBeLessThan(8_192);
  });
});
