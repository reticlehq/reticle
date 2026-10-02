/**
 * The session gap, as a person reads it — and as a Stop hook prints it.
 *
 * `gapSummary` folds the journal into what was claimed and what held. This is its only renderer, so
 * `reticle report` and the hook cannot describe the same session two different ways.
 */
import type { GapSummary } from './gap-summary.js';

const HOOK_PREFIX = 'Reticle: not verified.';
const NO_CLAIM_HOOK = `${HOOK_PREFIX} No claim was checked this session`;
const NO_CLAIM_REPORT = 'no claims this session, so nothing was verified';

const plural = (n: number, word: string): string => `${String(n)} ${word}${1 === n ? '' : 's'}`;

/**
 * One line when the agent finishes without a single `yes`, and nothing otherwise.
 *
 * Silent after a `yes` on purpose: a hook that speaks on every stop is a hook people turn off, and the
 * question it exists to raise is "did anything get proved at all". Every answer that is not a yes is
 * counted by name — an `unknown` is never folded into anything, because that fold is the false green.
 */
export function gapHookLine(gap: GapSummary): string | undefined {
  if (0 < gap.held) return undefined;
  if (0 === gap.claims) return NO_CLAIM_HOOK;
  const parts = [
    0 < gap.failed ? `${String(gap.failed)} failed` : undefined,
    0 < gap.undecided ? `${String(gap.undecided)} unknown` : undefined,
    0 < gap.nothingToProve ? `${String(gap.nothingToProve)} proved nothing` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${HOOK_PREFIX} ${plural(gap.claims, 'claim')}: ${parts.join(', ')}`;
}

/** The whole gap: held of claimed first, then each kind of not-held with who can act on it. */
export function gapReportLines(gap: GapSummary): string[] {
  if (0 === gap.claims) return [NO_CLAIM_REPORT];
  const lines = [`${String(gap.held)} of ${plural(gap.claims, 'claim')} held`];
  if (0 < gap.failed) {
    const caught =
      0 < gap.falseGreensCaught
        ? `, ${String(gap.falseGreensCaught)} of them a green a channel contradicted`
        : '';
    lines.push(`${String(gap.failed)} failed${caught}`);
  }
  if (0 < gap.undecided) {
    const owners = Object.entries(gap.undecidedBy)
      .map(([owner, n]) => `${owner}: ${String(n)}`)
      .join(', ');
    lines.push(`${String(gap.undecided)} unknown${'' === owners ? '' : ` (${owners})`}`);
  }
  if (0 < gap.nothingToProve) lines.push(`${String(gap.nothingToProve)} proved nothing`);
  for (const failure of gap.failures) lines.push(`  ✗ ${failure.claim}`);
  return lines;
}
