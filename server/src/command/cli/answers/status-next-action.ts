/**
 * The sentence `status` owes the user, because `init` promised it.
 *
 * `init` closes with "run `npx @reticlehq/server status` — it confirms the app connected, or says
 * exactly why it has not". On a real install, following that instruction printed `running: false,
 * presence: "free"` and nothing else: no reason, no next step, no mention of the app. This is the last
 * checkpoint in the setup path, so a user who arrives here and learns nothing has nowhere left to go.
 *
 * Deliberately thin. The differential already exists in `nextActionFor`, which ranks these causes from
 * what the daemon knows and was rewritten this week to stop leading with a port mismatch; a second
 * differential here could disagree with the first, and two confident answers pointing different ways
 * is worse than one. This only supplies the facts the CLI has and renders the answer.
 */

import { nextActionFor } from '../../../portal/session/no-session-next-action.js';

export interface StatusFacts {
  /** Is a usable daemon answering on this port? */
  running: boolean;
  /** Live browser sessions the daemon reports. */
  sessionCount: number;
  /** Has an app for this project ever connected on this port? Durable, survives a daemon restart. */
  previouslyConnected: boolean;
  /**
   * Has `init` run in this project — i.e. is there a `.reticle.json` with a projectId?
   *
   * Was hardcoded `true` at the call below, which made the one branch that can say "run init"
   * unreachable from `status` however unwired the project was. That is the commonest reason this
   * command has nothing to report: registering the MCP server does not wire the app, and several
   * paths do the first without the second.
   */
  initialized: boolean;
  /**
   * Has THIS project connected before, as opposed to any app on this port.
   *
   * Both facts are needed and they are not interchangeable. `previouslyConnected` is wide: with
   * no project id its helper falls back to "has this daemon ever served anything", which is the
   * right answer for ranking a dev-server hint and the wrong one for any sentence about the
   * directory the reader is standing in. Every claim below that says "this project" or decides
   * whether THIS app is instrumented uses the narrow one.
   */
  projectPreviouslyConnected: boolean;
  /**
   * Ports of dev servers that ANNOUNCED themselves — i.e. that have Reticle loaded in the process
   * actually running.
   *
   * `nextActionFor` already ranks on a listening-port list; it just never had one from here, so this
   * command passed `[]` and every wired project with a live dev server was told "the app is probably
   * not running". That is advice contradicting the terminal the reader is looking at, and it sends
   * them to restart something already up.
   *
   * Stronger than the port scan the field was designed for: a scanned port proves something is
   * listening, an announced one proves it is listening AND instrumented. Optional so every existing
   * caller keeps today's behaviour.
   */
  devServerPorts?: readonly number[];
}

/**
 * What to do next, or `undefined` when a session is connected and there is nothing to fix.
 *
 * The success case has to stay silent: advice printed beside a working session reads as though
 * something is still wrong, which is its own kind of lie.
 */
export function statusNextAction(facts: StatusFacts): string | undefined {
  if (facts.sessionCount > 0) return undefined;

  if (!facts.running) {
    // `running: false` reads as "Reticle is broken", and it usually means the opposite: the daemon is
    // started by an agent, on demand, and idles out when nobody is driving. A user who has not
    // attached an agent yet is exactly on track, and saying so is the whole job of this branch.
    // `previouslyConnected` answers the WIDE question — has any app connected on this port —
    // because `hasAnyAppConnectedBefore` falls back to that when the directory has no project id, and
    // the branch below genuinely wants the wide answer: plugin-based wiring can connect without
    // ever writing `.reticle.json`.
    //
    // The sentence here is NARROW. "This project has connected before" attributes a connection to
    // the directory the user is standing in, and with no project id there is nothing to attribute
    // it to. Run `status` in an empty directory on a machine that has ever used Reticle and the
    // old version said the wiring was correct, in a directory with no app, no config and no
    // instrumentation — the confident-but-unevidenced reassurance this command exists to avoid,
    // and the same shape as the port-mismatch claim removed from the lease hint.
    //
    // So the wide fact gets the wide sentence. Losing the reassurance is the point when the thing
    // it reassures about cannot be checked.
    const wiring = facts.projectPreviouslyConnected
      ? 'This project has connected before, so the wiring is correct.'
      : facts.previouslyConnected
        ? 'An app has connected on this port before, though nothing here identifies this directory as that project.'
        : '';
    return (
      `no daemon is running on this port, which is normal — an agent starts it when it first calls a ` +
      `Reticle tool, and it exits again when idle. ${wiring} Ask your agent to verify something, then ` +
      `run status again.`
    ).replace(/\s+/g, ' ');
  }

  // Only diagnose instrumentation after a live daemon makes that diagnosis possible. When the
  // daemon is absent, claiming the app is unwired confuses missing evidence with evidence of a
  // missing install. A previous connection overrides this branch because plugin-based wiring may
  // connect without creating `.reticle.json`.
  //
  // THIS project's previous connection, not any. The override used to read the wide fact, so a
  // stranger's app touching this port once was enough to silence "your app is not instrumented,
  // run init" for every uninstrumented directory afterwards. Driving it produced the symptom:
  // a live daemon, an empty directory, and `status` with no advice at all, while `doctor` two
  // commands later said the app was not instrumented.
  if (!facts.initialized && !facts.projectPreviouslyConnected) {
    return (
      'no app has ever connected for this project, and there is no Reticle config here — so the ' +
      'tools are registered and the app itself is not instrumented. Those are two different halves ' +
      'of the install. Run `npx @reticlehq/server init` in the app directory, then start the dev ' +
      'server and load the page.'
    );
  }

  // The daemon is up and no page has connected. `nextActionFor` owns the ranking; this passes what
  // it has and lets that function say what is missing rather than guessing at it. It CAN see
  // listening ports now — the announced ones — which is what the empty list here used to cost.
  const next = nextActionFor({
    // The durable bit IS this side's `everConnected`. In-process the flag means "this daemon has served
    // a session", which a daemon seconds old cannot know; from the CLI the honest equivalent is "an app
    // for this project has connected on this port", which is the fact that decides whether the wiring
    // is in question at all.
    // The comment above this line already described the narrow question — "an app for this
    // project has connected on this port" — while the wide value was being passed.
    everConnected: facts.projectPreviouslyConnected,
    initialized: facts.initialized,
    listening: facts.devServerPorts ?? [],
    dev: undefined,
    previouslyConnected: facts.projectPreviouslyConnected,
  });
  return next.reason;
}
