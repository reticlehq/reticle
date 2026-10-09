/**
 * Harness credits, as the platform grants them and as every surface says them.
 *
 * One file because the HUD's row and the daemon's refusal must say the same sentence: when the two
 * were written apart, the HUD offered "a free monthly allowance" the platform no longer grants.
 * The numbers are always the platform's (`limit`); only the trial length is not on the wire.
 *
 * Served from `@reticlehq/core/hud` only: from the root entry it rode into every page's first load.
 */

import { CreditKind } from './impact.js';

/** The trial a card starts. Not on the wire; the platform's own sentence names it the same. */
export const TRIAL_DAYS = 14;

export interface Credits {
  used: number;
  limit: number;
  kind?: CreditKind | undefined;
}

const count = (n: number): string => n.toLocaleString('en-US');

/** Nothing left. An unbounded plan (no credits reported) never is. */
export function creditsSpent(credits: Credits | undefined): boolean {
  return credits !== undefined && credits.used >= credits.limit;
}

/** "8 of 10 free credits", "420 of 500 trial credits", else "N of M credits left". */
export function creditsLeftText(credits: Credits): string {
  const of = `${count(Math.max(0, credits.limit - credits.used))} of ${count(credits.limit)}`;
  if (CreditKind.FREE === credits.kind) return `${of} free credits`;
  if (CreditKind.TRIAL === credits.kind) return `${of} trial credits`;
  return `${of} credits left`;
}

/** The sentence for no credits left, and the one thing that gets more when there is one. */
export function creditsUsedText(credits: Credits): { said: string; action?: string } {
  if (CreditKind.FREE === credits.kind)
    return {
      said: `Your ${count(credits.limit)} free credits are used.`,
      action: `Add a card to start your ${String(TRIAL_DAYS)}-day trial`,
    };
  if (CreditKind.TRIAL === credits.kind)
    return {
      said: `Your ${count(credits.limit)} trial credits are used. Pro starts when your trial ends.`,
    };
  return { said: "This month's credits are used. They renew over the next 30 days." };
}

/** The same, as one terminal line, with where to act when there is somewhere. */
export function creditsUsedLine(credits: Credits, planUrl: string): string {
  const text = creditsUsedText(credits);
  if (text.action !== undefined) return `${text.said} ${text.action}: ${planUrl}`;
  return CreditKind.TRIAL === credits.kind ? `${text.said} Plan: ${planUrl}` : text.said;
}
