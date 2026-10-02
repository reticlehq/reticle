/**
 * The one file an agent re-reads every turn must name the values and tools it will actually meet.
 *
 * `RULE_BODY` is written into CLAUDE.md / AGENTS.md / the Cursor rule, so it is the only Reticle
 * text that survives a compaction. Everything else — SKILL.md, the cheat sheet, usage.md, the MCP
 * handshake — is paid once and lost. Measured on this branch, it named nine tools out of the
 * forty-five callable, and did not name:
 *
 *   `no-fault`      a verdict value that is NOT a pass
 *   `reticle_run`   the only route to the ~30 tools the default surface does not advertise
 *   `reticle_context` the run's own memory, which is what an agent needs precisely when its own is gone
 *   `reticle_intent`  what a change was meant to do, captured while somebody still knows
 *
 * `no-fault` became urgent with the undeclared-verdict fix. Before it, an `act_and_wait` with no
 * `until` returned `verified:"yes"`; it now correctly returns `no-fault`. That moves a value an
 * agent had rarely seen onto the most common path in the product — so a rules file that explains
 * `unknown` and not `no-fault` now hands the agent a verdict it has no instruction for, and the
 * plain-English reading of "no fault" is "nothing wrong", i.e. a pass. That is the exact
 * misreading this file exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { RULE_BODY } from './project/agent-rules.js';

describe('the every-turn rules name the verdict values an agent will meet', () => {
  it('names `no-fault`, now that the undeclared path returns it', () => {
    expect(RULE_BODY).toContain('no-fault');
  });

  it('says plainly that no-fault is not a pass', () => {
    // The words matter: "no fault" reads as "nothing wrong" to anyone who has not been told.
    const near = RULE_BODY.slice(RULE_BODY.indexOf('no-fault'));
    expect(near.slice(0, 400)).toMatch(/not a pass|never as working|is not verification/i);
  });

  it('still covers `unknown`', () => {
    expect(RULE_BODY).toContain('unknown');
  });
});

/**
 * The escape hatch these used to name does not exist on the surface the reader gets.
 *
 * They required `reticle_run`, `reticle_context` and `reticle_intent` by name, on the premise —
 * written in this file's header — that `reticle_run` is "the only route to the ~30 tools the default
 * surface does not advertise". MEASURED by driving a real install: the default surface is `merged`,
 * and `advertisedTools` DROPS `reticle_run` from it. Calling an unadvertised tool answers "exists in
 * this build but is not reachable on this tool surface … there is no dispatch tool here to route
 * through". So the rules file promised a route that is not there, and these guards required it to.
 *
 * The INTENT survives and is what is checked now: a tool-not-found must not be terminal, so the
 * rules have to name something the reader can actually do about it. On this surface that is
 * `reticle_tools` (advertised, and the only way to see a merged tool's full parameters) and the
 * daemon flag that advertises the wider set.
 */
describe('the every-turn rules name the escape hatches', () => {
  it('names `reticle_tools`, which is the one that is actually advertised', () => {
    expect(RULE_BODY).toContain('reticle_tools');
  });

  it('says how to reach the wider surface, rather than naming a dispatch tool that is absent', () => {
    expect(RULE_BODY).toContain('RETICLE_ADVERTISE_ALL_TOOLS');
    expect(RULE_BODY, 'the merged surface has no dispatch tool to route through').not.toContain(
      'reticle_run',
    );
  });
});

describe('it stays short enough to be re-read every turn', () => {
  /**
   * The budget is the reason this file is valuable and the reason it must not grow without limit —
   * it is paid on every turn of every session, unlike every other document Reticle ships.
   */
  it('is under 12KB', () => {
    expect(RULE_BODY.length).toBeLessThan(12_000);
  });
});
