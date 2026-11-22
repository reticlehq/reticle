/**
 * What a tab that is only WATCHING gets to see of a drive happening somewhere else.
 *
 * Its own module because it is its own question — the rest of session.ts is about a session Reticle
 * is DRIVING, and this is about the one it is not. Split out when session.ts crossed the 1000-line
 * cap; the cap did its job, because these two had no reason to share a file beyond history.
 */

import { COMPUTER_USE_RUNTIME, ReticleCommand } from '@reticlehq/core';

/**
 * How a mirrored row is introduced on a tab that is only WATCHING.
 *
 * The row happened somewhere else, and a HUD that prints it unlabelled tells the reader their own
 * tab was driven. Naming the session is also the handle they need to address it.
 */
export function mirroredNarration(sessionId: string, text: string): string {
  return `${sessionId} \u2192 ${text}`;
}

/** The pushes that are a REPORT of what happened, and so are worth showing to a watching tab. */
export const MIRRORED_COMMANDS: ReadonlySet<string> = new Set<string>([
  ReticleCommand.NARRATE,
  ReticleCommand.IMPACT,
  // A replay usually reloads the page, so its progress has to reach whichever tab is there now.
  ReticleCommand.FLOW_PROGRESS,
  ReticleCommand.PLAN,
]);

/** A narration row re-addressed to a tab that is watching rather than being driven. */
export function mirroredArgs(
  sessionId: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const text = args['text'];
  if ('string' !== typeof text) {
    return args;
  }
  return { ...args, text: mirroredNarration(sessionId, text) };
}

/** A session that can be told a narration row: the part of `Session` that this needs. */
export interface Told {
  readonly id: string;
  readonly runtime: string | undefined;
  pushNarration(text: string, mirror?: boolean): void;
}

/**
 * Tells each desktop session what an act did in a page: its HUD is the one log the person reads
 * while computer use is live, and it showed only its own actions. Not mirrored again, and never
 * to a page, which shows its own act. An act of a desktop session tells nobody: its HUD has it.
 */
export function tellDesktops(from: Told, viewers: readonly Told[], reply: unknown): void {
  if (from.runtime === COMPUTER_USE_RUNTIME) {
    return;
  }
  const r = 'object' === typeof reply && null !== reply ? (reply as Record<string, unknown>) : {};
  const { action, role, name } = r;
  if ('string' !== typeof action) {
    return;
  }
  const target =
    'string' === typeof role && 'string' === typeof name && name !== '' ? ` ${role} "${name}"` : '';
  for (const viewer of viewers) {
    if (viewer.runtime === COMPUTER_USE_RUNTIME) {
      viewer.pushNarration(mirroredNarration(from.id, `${action}${target}`), false);
    }
  }
}

/**
 * The sessions that see what `driven` is told: the other tabs of its app, and every desktop
 * session. A desktop session is in a project of its own, and its HUD is the one log of the whole
 * machine that the person reads while computer use is live, so it saw nothing of a browser tab.
 */
export function withDesktops<T extends { readonly runtime: string | undefined }>(
  all: readonly T[],
  sameAppOf: (all: T[]) => T[],
  driven: T,
): T[] {
  const sameApp = sameAppOf([...all]);
  const desktops = all.filter((s) => s.runtime === COMPUTER_USE_RUNTIME && !sameApp.includes(s));
  return [...sameApp, ...desktops].filter((s) => s !== driven);
}
