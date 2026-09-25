/**
 * Why the bridge refused a HELLO — the specific reason when there is one.
 *
 * A daemon left running by one project answers the next project's app and rejects it on token, and
 * the SDK printed `bridge refused the connection: authentication failed`. That sends someone to
 * check a token which is perfectly correct — it is simply a DIFFERENT project's token. The two cases
 * need opposite fixes: "your token is wrong" versus "that daemon is not yours, stop it".
 *
 * The discriminator is EVIDENCE, not derivation. The daemon and the SDK derive project ids by
 * different schemes (the SDK from its Vite root, the daemon from its own cwd), so comparing those
 * would report "different project" on every auth failure — the same confidently-wrong diagnostic
 * this exists to replace. What the daemon knows for certain is which projects it has ALREADY
 * accepted a session from; if it has served X and a HELLO arrives for Y, it demonstrably belongs to
 * someone else.
 *
 * A HELLO with no token at all is a third case, and a reload cannot fix it: the CDN snippet and a
 * Next config evaluated before any token existed froze an empty credential into the page. Naming
 * that is what stops the close reason from prescribing a recovery that cannot work.
 *
 * With no evidence — a fresh daemon, or a HELLO naming no project — nothing is inferred and the
 * plain reason stands, unless the page sent no token.
 */

import { RETICLE_TOKEN_GLOBAL } from '@reticlehq/core';

const PLAIN = 'authentication failed';
/**
 * A token WAS presented and did not match. That is not "check your credentials" — the page holds a
 * real token from a state directory this daemon does not own, which in the field means a dev server
 * that does not share a filesystem with the daemon (container, devcontainer, WSL), or a page served
 * before `~/.reticle` was replaced. Both need the same first move: ask `status`, which can say which.
 */
const WRONG_TOKEN =
  'authentication failed: wrong pairing token — run `reticle status` for the cause';
/**
 * The page sent an empty token, which in practice means the build never put one there.
 *
 * Every connect snippet reads the token as `typeof __RETICLE_TOKEN__ !== 'undefined' ? ... : ''`,
 * so a build whose `define` did not run sends `''`, not the placeholder: Vite 8 / rolldown left the
 * Reticle globals as raw identifiers, and `vite.define` never reaches an Astro inline script. The
 * other way to get here is a build that ran before the daemon had written a token, which inlines
 * `''` too, like a paste-in snippet or a Next config evaluated before any token existed. A reload
 * cannot mint a token in either case, so the reason names the build rather than the credential
 * (#996).
 */
const NO_TOKEN = `authentication failed: no pairing token — the build did not substitute ${RETICLE_TOKEN_GLOBAL}, or ran before the daemon`;
/** WebSocket close reasons are capped at 123 bytes; a longer one throws and closes with nothing. */
const MAX_REASON_BYTES = 123;

const DIFFERENT_PROJECT_PREFIX = 'this daemon serves a different project';

/**
 * Whether a recorded close is a pairing-token refusal.
 *
 * The bridge records the specific sentence it sent on the socket, not one fixed string, so a
 * comparison with a single constant misses a wrong token, a missing token, and a daemon that
 * belongs to another project. All three are refusals. A later good session is a separate question
 * the caller answers with `connectedSinceLastClosure`.
 */
export function isAuthRefusalReason(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  return reason.startsWith('authentication failed') || reason.startsWith(DIFFERENT_PROJECT_PREFIX);
}

export function authFailureReason(
  servedProjects: ReadonlySet<string>,
  helloProject: string | undefined,
  helloToken?: string,
): string {
  // ONE served project, not merely some. A daemon that has accepted sessions from SEVERAL projects
  // is demonstrably not owned by any one of them, so "that daemon is not yours, stop it" is the
  // wrong story — and its advice is actively harmful there, because stopping it breaks the projects
  // that are working. This is the normal shape for a globally-registered daemon, which several
  // editors start from the user's home directory and point at everything.
  //
  // With one served project the inference holds and is worth making: the daemon belongs to that
  // project and this HELLO is somebody else's. With several, the token is the suspect, and the plain
  // reason says so without prescribing a recovery that costs other people their sessions.
  if (
    helloProject !== undefined &&
    1 === servedProjects.size &&
    !servedProjects.has(helloProject)
  ) {
    const reason = `${DIFFERENT_PROJECT_PREFIX} — run \`reticle stop\` and retry`;
    return Buffer.byteLength(reason, 'utf8') <= MAX_REASON_BYTES ? reason : PLAIN;
  }
  if (helloToken === undefined || 0 === helloToken.length) {
    return Buffer.byteLength(NO_TOKEN, 'utf8') <= MAX_REASON_BYTES ? NO_TOKEN : PLAIN;
  }
  return Buffer.byteLength(WRONG_TOKEN, 'utf8') <= MAX_REASON_BYTES ? WRONG_TOKEN : PLAIN;
}
