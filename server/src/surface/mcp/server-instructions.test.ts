import { describe, it, expect } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { CORE_TOOL_NAMES } from '../tools/tool-surface.js';
import { buildServerInstructions } from './server-instructions.js';

/**
 * The instructions string is the only channel that reaches an agent with no skill file, no restart
 * and no action from the user — so what it leads with is the product's real first impression.
 *
 * It used to open on tool grammar, which is the right thing to say to an agent that has an app to
 * point the tools at and the wrong thing to say to one that does not. The overwhelming majority of
 * daemons in the field never see an app connect, never run a command and never call a tool: the
 * step being missed is not a hard one, it is one nobody was ever asked to take.
 */
describe('buildServerInstructions', () => {
  describe('when no app has ever connected to this project', () => {
    const text = buildServerInstructions({ previouslyConnected: false });

    it('leads with instrumenting the app, not with the tool list', () => {
      const lead = text.slice(0, 400);
      expect(lead).toMatch(/not instrumented|no app/i);
      expect(lead).toContain('init');
      // The tool grammar must not be the first thing an agent with no app reads.
      expect(lead).not.toContain('reticle_snapshot');
    });

    it('names the command to run and how to confirm it worked', () => {
      expect(text).toContain('init');
      // Resolved from the live surface, so this is `reticle_session` now that the nine is the
      // default. Asserting the literal `reticle_sessions` would pin a name the reader is not given.
      expect(text).toContain(ReticleTool.SESSION);
    });

    it('still carries the verdict discipline and the feedback ask', () => {
      expect(text).toContain(ReticleTool.ACT_AND_WAIT);
      // Feedback is an action on the session tool wherever the family is merged.
      expect(text).toMatch(/reticle_feedback|reticle_session \{action:"feedback"\}/);
    });
  });

  describe('when an app has connected to this project before', () => {
    const text = buildServerInstructions({ previouslyConnected: true });

    it('does not open by telling a wired project to run init', () => {
      expect(text.slice(0, 400)).not.toContain('init');
    });

    it('leads with what the tools are for', () => {
      // The LOOKING tool, whatever this surface calls it: `reticle_snapshot` unmerged,
      // `reticle_look {action:"page"}` on the nine.
      expect(text.slice(0, 200)).toMatch(/reticle_snapshot|reticle_look/);
    });

    it('keeps the verdict discipline and the feedback ask', () => {
      expect(text).toContain(ReticleTool.ACT_AND_WAIT);
      expect(text).toMatch(/reticle_feedback|reticle_session \{action:"feedback"\}/);
    });

    /**
     * Both tools sit on the EXTENDED surface, so neither appears in the list an agent is handed by
     * default. Named nowhere, they are built and unreachable — an agent connecting today cannot
     * learn they exist, which makes their effect size zero whatever the engineering behind them.
     * This is the only channel that reaches an agent that never read the skill file.
     */
    it('names the two tools an agent would otherwise never learn exist', () => {
      // On a surface WITH a dispatch hatch. The nine has none, and the briefing correctly stays
      // silent there rather than naming two tools that answer "not found" — which is the same rule
      // this pair of tests was written to enforce, applied to a surface that did not exist yet.
      const wider = buildServerInstructions({
        previouslyConnected: true,
        advertised: [...CORE_TOOL_NAMES, ReticleTool.TOOLS, ReticleTool.RUN],
      });
      expect(wider).toContain(ReticleTool.CONTEXT);
      expect(wider).toContain(ReticleTool.INTENT);
    });

    /**
     * Naming them was half a fix. Neither is advertised, so a bare name sent an agent at a tool
     * `tools/list` does not contain: it burns a call, gets "unknown tool", and learns that the
     * instructions cannot be trusted — which is more expensive than never having been told.
     */
    it('gives both of them the reticle_run call that actually reaches them', () => {
      const wider = buildServerInstructions({
        previouslyConnected: true,
        advertised: [...CORE_TOOL_NAMES, ReticleTool.TOOLS, ReticleTool.RUN],
      });
      expect(wider).toContain('reticle_run({ tool: "reticle_context"');
      expect(wider).toContain('reticle_run({ tool: "reticle_intent"');
      // And the nine, which cannot reach them, names neither rather than both.
      expect(text).not.toContain(ReticleTool.CONTEXT);
    });
  });

  it('stays short enough to be read in full, in both states', () => {
    // Every connected agent pays this in every session. A first move nobody finishes reading is
    // not a first move.
    //
    // Raised from 2,600 to admit the shared-argument vocabulary, and only that. The budget it buys
    // back is real and one-sided: those three arguments were documented identically on sixteen
    // tools, costing 1,367 bytes of the surface RE-SENT EVERY TURN, against 300-odd bytes here
    // charged once. Anything added beyond that has to make the same argument — a paragraph that is
    // not replacing per-turn repetition is just a longer preamble, and the reason for the cap is
    // attention, not bytes.
    //
    // Raised again to 3,200 for the reach-for block, which makes that argument in a second form.
    // Four advertised tools (observe, wait_for, inspect, session) were re-sent in full on EVERY
    // turn as part of the ~18 KB surface and explained nowhere, so the model had schemas it could
    // use and no basis on which to choose — and the measured cost of that on observe alone was
    // triple the false alarms. Roughly 600 bytes charged once, to make several KB per turn
    // reachable, is the same trade with the numbers in the same direction. The first-run state,
    // where a longer preamble would do the most harm, is unchanged but for two tool names.
    //
    // Raised again to 3,350 for the stopping rule — one sentence, and the only one here that
    // pushes toward LESS work. Every other line pushes toward more checking, which is right when
    // something is broken and is the entire bill when nothing is. Measured in the competitor
    // benchmark on a HEALTHY app: this agent spent 22 turns and roughly 3.5x the cheapest
    // competitor's tokens confirming nothing was wrong, on a page whose FIRST verdict had already
    // come back "yes" over a clean capture. It was not payload — that run had the smallest
    // tool-result payload of its five. It was turns nobody had told it to stop taking.
    //
    // Raised again to 3,500 for the diagnose-from-source rule, cut to one sentence to earn it.
    //
    // THIRD raise in one release, and the ratchet is the thing to watch: a cap that moves whenever
    // something wants in is not a cap. It holds only because each raise has been paid for with a
    // measurement, and because the two before it were checked afterwards — the stopping rule cut
    // the healthy-app control from 275k to a 123k mean over three runs. If a future raise cannot
    // show that, the right answer is to cut an older sentence instead of adding to the budget.
    // Measured on a fix-and-verify benchmark, split at the call that writes the fix: this agent
    // spent 14 and 18 calls BEFORE its first edit where a competitor spent 8 and 9, and per-turn
    // cost was identical on the hardest cell — so the whole gap was turns spent asking a browser a
    // question only source can answer. ~150 bytes charged once against turns charged every run.
    // FOURTH raise, to 4,000, for the replay rule — 479 characters on the connected branch, and the
    // measurement behind it is the largest any of these has had. Across 13 agent cells and 323 tool
    // calls, with 29 saved flows on disk the whole time, replay was invoked ZERO times: the engine
    // was built, tested and reachable, and nothing ever told an agent it existed. `reticle_verify`
    // explains it in its own description, and both shipping surfaces trim that from 1,791
    // characters to 93, which removes every word about flows — so this string is the only channel
    // that survives. Measured price of the thing it avoids: one scenario cost 14-22 turns and
    // 201k-325k tokens to drive, against roughly 460 tokens to replay a flow that covers it. 479
    // characters charged once per session against a drive charged every time nothing replays.
    //
    // The ratchet warning above still stands, and this raise accepts its terms: if the next one
    // cannot show a number like that, cut an older sentence instead.
    for (const previouslyConnected of [true, false]) {
      expect(buildServerInstructions({ previouslyConnected }).length).toBeLessThan(4000);
    }
  });
});

describe('diagnosis starts in the source, not in the browser', () => {
  it('says so in both states, and names the order', () => {
    for (const previouslyConnected of [true, false]) {
      const text = buildServerInstructions({ previouslyConnected });
      expect(text).toMatch(/Read the source first/);
      expect(text).toMatch(/CONFIRM a fix, not to find one/);
    }
  });
});

describe('the one instruction that asks for less work', () => {
  /**
   * Everything else in this string pushes toward more checking. That is right when something is
   * broken and it is the whole bill when nothing is: on a healthy app in the competitor benchmark,
   * this agent spent 22 turns confirming that nothing was wrong, after its FIRST verdict had
   * already come back "yes" over a clean capture.
   */
  it('tells the agent when it is finished, in both states', () => {
    for (const previouslyConnected of [true, false]) {
      const text = buildServerInstructions({ previouslyConnected });
      expect(text).toMatch(/clean capture IS the answer/);
      expect(text).toMatch(/stop\./);
    }
  });
});

/**
 * The replay rule reaches the agent, on the surfaces that can act on it.
 *
 * THE INCIDENT. Measured across 13 agent cells and 323 tool calls, with 29 saved flows present on
 * disk throughout: replay was invoked ZERO times. The capability was built, tested, reachable and
 * completely invisible — `reticle_verify`'s description explains it in full, and both shipping
 * surfaces trim that description from 1,791 characters to 93, deleting every mention of flows. The
 * briefing is the only text that survives the trim, so the rule has to live there and has to keep
 * naming calls the live surface really advertises.
 */
describe('the briefing tells an agent to replay before it drives', () => {
  const NINE = [
    ReticleTool.NAVIGATE,
    ReticleTool.ACT,
    ReticleTool.ACT_AND_WAIT,
    ReticleTool.ASSERT,
    ReticleTool.OBSERVE,
    ReticleTool.LOOK,
    ReticleTool.SESSION,
    ReticleTool.VERIFY,
    ReticleTool.TOOLS,
  ];

  it('names the replay route on a surface that advertises it', () => {
    const text = buildServerInstructions({ previouslyConnected: true, advertised: NINE });
    // The merged surface reaches replay through actions on reticle_verify, never a bare tool name.
    expect(text).toContain(`${ReticleTool.VERIFY} {action:"change"}`);
    expect(text).toContain(`${ReticleTool.VERIFY} {action:"affected"}`);
  });

  it('says what each verdict means, and that unknown is not a pass', () => {
    const text = buildServerInstructions({ previouslyConnected: true, advertised: NINE });
    // The whole safety property: an agent that reads `unknown` as "fine" has turned the cheapest
    // path into a false green. If this sentence goes, the feature becomes a hazard.
    expect(text).toMatch(/unknown/i);
    expect(text).toMatch(/never report it as passing|nothing was proved/i);
    expect(text).toMatch(/replay before you drive/i);
  });

  it('reaches a project that has never connected, because that is where reach fails', () => {
    /*
     * This asserted the OPPOSITE for one commit, and the reasoning was wrong in a way worth keeping
     * written down. Gating on `previouslyConnected` sounds right — replay presupposes saved flows —
     * but that flag needs `readProjectId(cwd)` to resolve, and in a monorepo driven from the repo
     * root it is undefined. The rule would have been missing exactly where an agent is most likely
     * to be working, to save 479 characters on a first run.
     *
     * It is safe with no flows: `affected` names nothing, `change` answers `unknown`, and `unknown`
     * already means drive it. The advice degrades into the correct first move.
     */
    const text = buildServerInstructions({ previouslyConnected: false, advertised: NINE });
    expect(text).toMatch(/replay before you drive/i);
  });

  it('names no replay call a surface cannot reach', () => {
    // A briefing that names an unavailable tool does not merely confuse an agent — this module's
    // own header records that it makes the agent stop using the product.
    const withoutVerify = NINE.filter((n) => n !== ReticleTool.VERIFY);
    const text = buildServerInstructions({ previouslyConnected: true, advertised: withoutVerify });
    expect(text).not.toMatch(/replay before you drive/i);
    expect(text).not.toContain(ReticleTool.VERIFY);
  });
});
