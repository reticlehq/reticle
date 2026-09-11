import { describe, it, expect } from 'vitest';
import { statusNextAction } from './status-next-action.js';

/**
 * `status` has to answer the question `init` sends the user here to ask.
 *
 * `init` ends with, verbatim: "Then run `npx @reticlehq/server status` — it confirms the app connected,
 * or says exactly why it has not." On a real install, following that instruction printed:
 *
 *     {"event":"reticle_status","port":4400,"running":false,"presence":"free"}
 *
 * No reason, no next step, and no mention of the app. The promise was three lines earlier in the same
 * output. This is the last checkpoint in the setup path, so a user who reaches it and learns nothing
 * has nowhere left to go — and most users never get past this step.
 *
 * The differential itself is NOT rebuilt here: `nextActionFor` already ranks these causes from what
 * the daemon knows, and a second opinion that disagreed with the first would be worse than no second
 * opinion at all.
 */
describe('statusNextAction', () => {
  it('says an agent starts the daemon, when no daemon is running', () => {
    // The commonest reading of `running: false` is "Reticle is broken". It is not: the daemon is
    // started by the agent, on demand, and a user who has not attached one yet is exactly on track.
    const next = statusNextAction({
      running: false,
      sessionCount: 0,
      previouslyConnected: false,
      projectPreviouslyConnected: false,
      initialized: true,
    });
    expect(next).toBeDefined();
    expect(next?.toLowerCase()).toContain('agent');
  });

  it('does not tell an unidentified directory that ITS wiring is correct', () => {
    // Found by running `status` in an empty /tmp directory on a machine that had used Reticle
    // before. `previouslyConnected` is the WIDE fact — any app, this port — because the helper
    // behind it falls back to that when there is no project id, and another branch wants the
    // wide answer. This sentence was the narrow claim, so it attributed a stranger's connection
    // to a directory holding no app, no config and no instrumentation, and called the wiring
    // correct.
    const next = statusNextAction({
      running: false,
      sessionCount: 0,
      previouslyConnected: true,
      projectPreviouslyConnected: false,
      initialized: false,
    });
    expect(next).toBeDefined();
    expect(next).not.toContain('This project has connected before');
    expect(next).not.toContain('the wiring is correct');
    // The wide fact is still worth saying, in the words the evidence supports.
    expect(next).toContain('connected on this port before');
  });

  it('still says "not instrumented" when a STRANGER used this port', () => {
    // The silent case, found by driving: a live daemon, a directory with no config and no app,
    // and `status` returned nothing at all — while `doctor`, two commands later in the same
    // directory, said the app was not instrumented and to run init.
    //
    // The override exists so plugin-based wiring (which connects without writing .reticle.json)
    // is not told to run init. It read the WIDE fact, so any app that had ever touched this port
    // silenced the advice for every uninstrumented directory afterwards.
    const next = statusNextAction({
      running: true,
      sessionCount: 0,
      previouslyConnected: true,
      projectPreviouslyConnected: false,
      initialized: false,
    });
    expect(next).toBeDefined();
    expect(next).toContain('init');
  });

  it('stays quiet about init when THIS project connected without a config', () => {
    // The case the override is for: plugin-based wiring connects and writes no .reticle.json.
    // Telling that project to run init is the one action that cannot help and can overwrite a
    // working config.
    const next = statusNextAction({
      running: true,
      sessionCount: 0,
      previouslyConnected: true,
      projectPreviouslyConnected: true,
      initialized: false,
    });
    expect(next ?? '').not.toContain('init');
  });

  it('does not send a previously-connected project back to `init`', () => {
    // The install is known-good the moment an app has ever connected on this port, and `init` is the
    // one action that cannot help and can overwrite a config that works.
    const next = statusNextAction({
      running: false,
      sessionCount: 0,
      previouslyConnected: true,
      projectPreviouslyConnected: true,
      initialized: true,
    });
    expect(next).not.toContain('init');
  });

  it('names the missing piece when the daemon is up and nothing has connected', () => {
    const next = statusNextAction({
      running: true,
      sessionCount: 0,
      previouslyConnected: false,
      projectPreviouslyConnected: false,
      initialized: true,
    });
    expect(next).toBeDefined();
    expect(next).not.toBe('');
  });

  it('says the wiring is fine and the tab is missing, when an app connected here before', () => {
    const next = statusNextAction({
      running: true,
      sessionCount: 0,
      previouslyConnected: true,
      projectPreviouslyConnected: true,
      initialized: true,
    });
    expect(next?.toLowerCase()).toMatch(/wiring is correct|reopen/);
  });

  it('stays quiet when a session IS connected — there is nothing to fix', () => {
    // The success case must not carry advice. A "next action" printed next to a working session reads
    // as though something is still wrong.
    expect(
      statusNextAction({
        running: true,
        sessionCount: 1,
        previouslyConnected: true,
        projectPreviouslyConnected: true,
        initialized: true,
      }),
    ).toBeUndefined();
  });
});

/**
 * `status` is the last checkpoint in the setup path, and it was structurally incapable of naming the
 * commonest reason it has nothing to report: `init` was never run in this project.
 *
 * `initialized: true` was hardcoded at the call into `nextActionFor`, so the branch that says "run
 * init" could not be reached from here however unwired the project was. Someone who registered the
 * MCP server without ever running `init` — which is what the plugin and a hand-added client config
 * both do — followed the instruction `init` prints, arrived here, and was told to start their dev
 * server.
 */
describe('status can say that init was never run here', () => {
  it('reports the unavailable daemon before making any instrumentation claim', () => {
    const next = statusNextAction({
      running: false,
      sessionCount: 0,
      previouslyConnected: false,
      projectPreviouslyConnected: false,
      initialized: false,
    });
    expect(next).toMatch(/no daemon is running/);
    expect(next).not.toMatch(/not instrumented|run `npx @reticlehq\/server init`/);
  });

  it('names init when the daemon IS up and nothing has connected', () => {
    const next = statusNextAction({
      running: true,
      sessionCount: 0,
      previouslyConnected: false,
      projectPreviouslyConnected: false,
      initialized: false,
    });
    expect(next).toMatch(/init/);
  });

  it('does not send an initialized project to init', () => {
    const next = statusNextAction({
      running: true,
      sessionCount: 0,
      previouslyConnected: false,
      projectPreviouslyConnected: false,
      initialized: true,
    });
    expect(next ?? '').not.toMatch(/reticle init|server init/);
  });

  it('stays quiet when a session is connected, however unwired it looks', () => {
    expect(
      statusNextAction({
        running: true,
        sessionCount: 1,
        previouslyConnected: false,
        projectPreviouslyConnected: false,
        initialized: false,
      }),
    ).toBeUndefined();
  });
});
