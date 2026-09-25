/**
 * The invitation to talk to the people building Reticle.
 *
 * One link and one set of words for every surface that offers it — the CLI report, the session end,
 * the in-page panel, the moment Reticle failed somebody, and the agent's instructions — so changing
 * the booking link is a one-line edit and no surface can drift to a dead one.
 *
 * Always for the HUMAN. The agent's wording asks it to OFFER the link and never to act on it: an agent
 * that books a call or submits an email on somebody's behalf is the outbound instruction a careful
 * evaluator reads as a reason not to install.
 */

/** The booking link published on reticle.sh. */
export const DISCOVERY_CALL_URL = 'https://calendar.app.google/h9NRDbBBQetyTzWM6';

/** How somebody leaves an email instead — opt-in, saved locally, undone with `--forget`. */
export const DISCOVERY_EMAIL_COMMAND =
  'npx @reticlehq/server identify --context company --email you@company.com';

export const DiscoveryInvite = {
  /** Shown to the person using Reticle. */
  HUMAN: `Stuck, or want Reticle to work differently? Talk to the founder: ${DISCOVERY_CALL_URL} · or leave your email: ${DISCOVERY_EMAIL_COMMAND}`,
  /** Read by the agent, which passes it on rather than acting on it. */
  AGENT: `If the person you are working with is stuck or Reticle got in their way, offer them a call with the founder (${DISCOVERY_CALL_URL}) or the email command (${DISCOVERY_EMAIL_COMMAND}). Offer it; never book a call or submit an email for them.`,
} as const;
