/**
 * Which session to use for what, when a desktop application and a page are both connected.
 *
 * A computer-use session reads an application through the operating system. An SDK session is
 * inside its app. One agent can hold both, and the list said nothing about the difference: an
 * agent then drove a page through the desktop session, which sees no network, no state and no
 * source file, or it looked in the page for a dialog that belongs to the system.
 */
import { COMPUTER_USE_RUNTIME } from '@reticlehq/core';
import { z } from 'zod';

export const REALMS_FIELD = 'realms';

const REALMS_DESCRIPTION =
  'Present only when a desktop application (computer use) and an app with the Reticle SDK are both connected. Says which session to use for what, and how to pass work from one to the other.';

export const REALMS_OUTPUT = {
  [REALMS_FIELD]: z
    .object({
      desktop: z.array(z.string()),
      insideTheApp: z.array(z.string()),
      rule: z.string(),
    })
    .optional()
    .describe(REALMS_DESCRIPTION),
};

export const REALMS_RULE =
  'Two kinds of session are connected. Use an insideTheApp session first for the page of its app: it sees the network, the state and the source file. Use a desktop session for what is outside that page: another application, a system dialog, a file panel, a window of the operating system. To pass work across, end your step in one session with a consequence you can check in the other, then send the next call with the other sessionId. Give sessionId on every call.';

/** The two kinds of session, and the rule for choosing. Absent unless both kinds are connected. */
export function realmsOf(
  sessions: readonly { sessionId: string; runtime?: string }[],
): { desktop: string[]; insideTheApp: string[]; rule: string } | undefined {
  const desktop = sessions
    .filter((s) => COMPUTER_USE_RUNTIME === s.runtime)
    .map((s) => s.sessionId);
  const insideTheApp = sessions
    .filter((s) => COMPUTER_USE_RUNTIME !== s.runtime)
    .map((s) => s.sessionId);
  if (0 === desktop.length || 0 === insideTheApp.length) {
    return undefined;
  }
  return { desktop, insideTheApp, rule: REALMS_RULE };
}
