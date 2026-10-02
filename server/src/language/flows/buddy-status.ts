/**
 * The buddy channel. The co-dev experience for the HUMAN: a single ambient line they can park in
 * a statusline or terminal and glance at — never a wall of output, never something they have to ask for.
 *
 * The rule this encodes: say the reassuring thing briefly and the alarming thing specifically. "41 flows
 * nominal" needs no detail; a deviation needs its name, because a status line that says only "1 deviation"
 * forces the human to go digging, which is exactly the work the buddy exists to remove.
 */

interface BuddyStatusInput {
  /** Every saved flow. */
  total: number;
  /** Flows with a passing artifact. */
  passing: number;
  /** Flows that changed files put at risk and that have NO passing artifact — the actionable set. */
  deviations: readonly string[];
  /** Flows quarantined as flaky — surfaced, never blocking. */
  quarantined: readonly string[];
}

/** How many deviation names to spell out before collapsing to a count (a status line must stay one line). */
const MAX_NAMED = 2;

/**
 * One line, safe to print on every save. Shape:
 * `✓ 41 flows nominal`
 * `✗ 2 deviations: checkout, billing · 39 nominal · 1 flaky quarantined`
 */
export function formatBuddyStatus(input: BuddyStatusInput): string {
  const parts: string[] = [];
  const deviations = input.deviations.length;

  if (0 === deviations) {
    parts.push(`✓ ${String(input.passing)}/${String(input.total)} flows nominal`);
  } else {
    const named = input.deviations.slice(0, MAX_NAMED).join(', ');
    const rest = deviations - Math.min(MAX_NAMED, deviations);
    parts.push(
      `✗ ${String(deviations)} deviation${1 === deviations ? '' : 's'}: ${named}${rest > 0 ? ` +${String(rest)} more` : ''}`,
    );
    parts.push(`${String(input.passing)} nominal`);
  }

  if (input.quarantined.length > 0) {
    parts.push(`${String(input.quarantined.length)} flaky quarantined`);
  }
  return parts.join(' · ');
}
