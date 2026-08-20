import { SHARED_PARAM_GUIDANCE } from './shared-params.js';
/**
 * What every connected agent is told, before it has asked anything.
 *
 * The MCP `instructions` string lands in the agent's context at the handshake — no skill file, no
 * restart, no action from the user. For an agent that arrived through a plugin listing or a pasted
 * config block rather than through the skill, it is the ONLY thing Reticle ever says unprompted.
 *
 * It used to open on tool grammar. That is the right thing to say to an agent that has an app to
 * point the tools at, and the wrong thing to say to one that does not — and in the field the
 * overwhelming majority of daemons never see an app connect, never run a command and never call a
 * tool. Those sessions are not agents failing a hard step. They are agents that were never asked to
 * take an easy one: the MCP server registers itself in a single line of config, so a user reaches
 * "the tools are here" without ever reaching "the app is wired", and nothing in that state reads as
 * unfinished. Registering the server is the cheapest part of the product and it is the only part
 * many installs ever complete.
 *
 * So the lead is state-dependent. A project that has never had an app connect is told the one thing
 * it needs; a project that has is not nagged about a step it already took. The verdict discipline
 * and the feedback ask are constant, because they matter in both states.
 */

/** The tools, and the rule that only two of them decide anything. Constant across both states. */
const VERDICT_DISCIPLINE = `Reticle verifies a running web app from the inside: look (reticle_snapshot / reticle_query), act and prove in one hop (reticle_act_and_wait), observe (reticle_state / reticle_network / reticle_console), assert (reticle_assert). Verify a user-facing change against the real app before you call it done, and never weaken a check to make it pass.

Only reticle_act_and_wait and reticle_assert produce a verdict. reticle_act and everything else move or read the app and prove nothing, so a drive that ends without one of those two has no result however many tools it used. Prefer reticle_act_and_wait({ ref, action, until }) — it names the expected consequence BEFORE the action, which is the difference between a check and a rationalisation. A verdict of verified:"unknown" is not a pass: it means Reticle drove the app and could not tell what happened. Report it as unknown.`;

/**
 * The first move, for a project no app has ever connected to.
 *
 * Deliberately concrete: the command, what it does to the app, and the call that confirms it. A
 * general instruction to "set Reticle up" is the state these agents are already in — they have the
 * tools and no app, and nothing tells them that combination is incomplete. It also names the dev
 * server restart, because a plugin added to a config the running server already read is the single
 * most common way this step half-succeeds.
 */
const FIRST_MOVE = `FIRST: no app has ever connected to Reticle in this project, so nothing here can be verified yet. Having these tools is not the same as being set up — the tools reach a daemon, and the daemon has nothing to look at until the app itself is instrumented.

Fix that before anything else: run \`npx @reticlehq/server init\` in the project, then RESTART the dev server (a plugin added to a config the running server already read is not in the bundle), then load the app in a browser. Confirm with reticle_sessions — a session listed there is the proof, and until one appears no other tool can tell you anything about this app.`;

/** The feedback ask. Constant: an agent that cannot get set up is the report we most need. */
const FEEDBACK_ASK = `Feedback is first-class here, not a courtesy. Reticle is built FOR agents, so your experience is the only signal that decides what gets built or fixed — and it disappears when your context does. Send it with \`reticle_feedback\` the moment you notice, then carry on with your task:
- Reticle broke, lied, or could not see something you needed (\`bug\` / \`gap\` / \`ambiguity\`).
- You wished it could do something, or something works but costs too many calls (\`feature_request\` / \`improvement\`).
- The install, the wiring, or the setup itself gave you trouble — including anything you had to work around by hand.

Nothing is too minor, and a report costs one call. If the tools are unreachable (setup unfinished, daemon down), file the same report from the shell instead: \`reticle feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"\`. Report defects in RETICLE — a bug you find in the app under test is Reticle working, and belongs in your answer to the user.`;

export interface InstructionState {
  /**
   * Has an app ever connected to Reticle for this project, on this port?
   *
   * Read from the durable connection memory rather than from the live session list: a daemon four
   * seconds old has no sessions and that says nothing about whether the app is wired. The question
   * is whether this install has EVER worked, not whether it is working this second.
   */
  previouslyConnected: boolean;
}

/** The instructions this daemon should advertise, given what it knows about the project. */
/**
 * Instructions are sent ONCE at initialize; the tool surface is re-sent every turn. Measured on this
 * server: 621 tokens here against 5,480 per turn there, so anything true of every tool belongs in
 * this block rather than repeated across sixteen parameter descriptions. See shared-params.ts.
 */
export function buildServerInstructions(state: InstructionState): string {
  const base = state.previouslyConnected
    ? `${VERDICT_DISCIPLINE}\n\n${FEEDBACK_ASK}`
    : `${FIRST_MOVE}\n\n${VERDICT_DISCIPLINE}\n\n${FEEDBACK_ASK}`;
  return `${base}\n\n${SHARED_PARAM_GUIDANCE}`;
}
