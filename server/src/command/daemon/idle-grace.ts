/**
 * How long an idle daemon is given before it shuts itself down.
 *
 * It used to be one number for every case, and at 5 minutes that number killed live runs: 187
 * `reticle_daemon_idle_shutdown` lines on one user's machine, with their editor's Reticle
 * disconnecting each time; and in the fixtures gate it fired during long dependency installs, so apps
 * that booted afterwards hit ERR_CONNECTION_REFUSED and were scored as install failures when nothing
 * was wrong with their install.
 *
 * Reverting is not an option. Daemons used to sit idle a median of 28 minutes at a 0.04% duty cycle
 * because "an agent is attached" alone kept one alive for a whole editor session, and the widened
 * rule is what fixed that.
 *
 * The distinction is TIME, not state. Mid-install an attached daemon is state-identical to one in an
 * empty directory — nothing has been asked of either. What differs is how long it is reasonable to
 * wait: quiet with a client attached means the human is thinking or the install is slow; the same
 * quiet with nobody attached means the daemon is unwanted. Both still exit.
 */

/**
 * An attached daemon waits this many times the base grace. Six is chosen against the two measurements
 * that matter: the default base is 5 minutes, so an attached daemon survives 30 — comfortably past
 * the slow installs that were killing runs, and comfortably short of the 28-minute median idle the
 * shorter rule was introduced to end.
 */
export const ATTACHED_GRACE_MULTIPLIER = 6;

/**
 * @param overrideMs an explicit attached grace (RETICLE_IDLE_ATTACHED_MS). Derived from the base when
 * absent — but the derived value is arithmetic on a number the caller also controls, and a test that
 * has to reason about both is a test that breaks for the wrong reason. Configuring it directly is
 * what lets the e2e spec assert the BEHAVIOUR (an attached daemon exits) without racing a product.
 */
export function idleGraceMs(baseMs: number, agentAttached: boolean, overrideMs?: number): number {
  // A non-positive base means the watcher is disabled; multiplying must not resurrect it.
  if (baseMs <= 0) return baseMs;
  if (!agentAttached) return baseMs;
  return overrideMs !== undefined && overrideMs > 0
    ? overrideMs
    : baseMs * ATTACHED_GRACE_MULTIPLIER;
}
