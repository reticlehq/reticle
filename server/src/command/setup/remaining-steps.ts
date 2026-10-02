/**
 * What is left to do by hand, from wherever setup stopped.
 *
 * Naming a cause is not the same as being recoverable. Setup can misbehave, and when it does the
 * caller should not have to re-read the whole procedure and work out for itself which parts already
 * worked — it should pick up at the step that did not. Ordered, and only ever the REMAINING steps.
 */

/** How far a run got. Everything here is knowable from the result object setup already builds. */
export interface Progress {
  readonly initDone: boolean;
  readonly devServerUp: boolean;
  readonly sessionConnected: boolean;
  readonly flowSaved: boolean;
  /** Set when the caller supplied a url, so nobody is told to start a server they already run. */
  readonly urlSuppliedByCaller: boolean;
  readonly url?: string | undefined;
  readonly devCommand?: string | undefined;
}

const DOCS_INDEX = 'https://docs.reticle.sh/llms.txt';
/**
 * The shell form on purpose, not `reticle_session { action: "feedback" }`.
 *
 * Every list this module returns is printed because a run did NOT finish, and the most common
 * reason it did not finish is that no session ever connected -- which is precisely the state where
 * the tool surface is unreachable. Naming the tool here would ask the reader to file through the
 * thing that is broken. The shell command needs no daemon and no session.
 */
const FEEDBACK_CMD =
  'npx @reticlehq/server feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"';

export function remainingSteps(p: Progress): string[] {
  const steps: string[] = [];
  if (!p.initDone) {
    steps.push('Run `npx @reticlehq/server@latest init` here, and fix every ⚠ it reports.');
  }
  if (!p.devServerUp && !p.urlSuppliedByCaller) {
    steps.push(
      `Start the dev server yourself: ${p.devCommand ?? 'the dev script in package.json'}, then open the app in a browser.`,
    );
  }
  if (!p.sessionConnected) {
    steps.push(
      'Confirm a session appears with `reticle_session { action: "list" }`. If the list is empty, read its ' +
        '`next_action`: the usual cause is a dev server that was already running when the build ' +
        'config was edited, so restart it and hard-reload' +
        (undefined === p.url ? '.' : ` ${p.url}.`),
    );
  }
  if (!p.flowSaved) {
    steps.push(
      'Prove one flow, which is the first run and is yours to start. Drive it yourself with the ' +
        '`reticle_*` tools, ending in `reticle_act_and_wait` or `reticle_assert` — those two are ' +
        'what produce a verdict. Or hand the whole drive to Reticle with `reticle_verify { action: ' +
        '"explore", persona: "<who does what>" }`, which records what it drove so later runs replay ' +
        'with no model in the loop; that route needs ANTHROPIC_API_KEY.',
    );
  }
  // Whether anything is actually outstanding, read BEFORE the docs pointer is added -- that line is
  // an offer, not a task, and a run with nothing left still gets it.
  const somethingIsOutstanding = 0 < steps.length;
  steps.push(`The whole procedure, if you need it: \`curl ${DOCS_INDEX}\`.`);
  // Asked only where something did not finish, which is the reader guaranteed to have something
  // worth telling us. The ask used to be printed by `init` before the dev server even started, so
  // it reached every reader EXCEPT the ones who hit a problem. Not asked on a clean run: a request
  // for a defect report at the end of a run that worked is noise, and noise is how an ask stops
  // being read at all.
  if (somethingIsOutstanding) {
    steps.push(
      `If any of that was Reticle's fault -- a step that did not match your project, a script that ` +
        `broke, a message that sent you the wrong way -- tell us, and it gets fixed: ${FEEDBACK_CMD}`,
    );
  }
  return steps;
}
