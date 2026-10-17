/**
 * What to do next, and who does it, when Reticle refuses something.
 *
 * One file because the daemon, the HUD and the agent each say part of the same answer. When each
 * wrote its own, the Harness refusal said `reticle connect` and the recovery beside it said
 * `npx @reticlehq/server connect`: two spellings of one command, in one answer.
 */

/** The command that signs a person in and links a project. The docs spell it this way. */
export const CONNECT_COMMAND = 'reticle connect';
