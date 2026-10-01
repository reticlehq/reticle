/**
 * The longest a single action may hold a pointer or a key down, in milliseconds.
 *
 * An unbounded `holdMs` is a tool call that never returns, which is the failure the transport layer
 * is shaped around. 30s is far above any real hold-to-confirm (the reported case was 1.2s) and far
 * below a hang.
 *
 * In core because BOTH sides clamp the same argument: the in-page dispatcher (a held mouse button,
 * a held key) and the real-input provider (a held key through the driver). Two caps would let the
 * same `holdMs` hold for longer through one path than the other.
 */
export const MAX_HOLD_MS = 30_000;

/** A hold the caller asked for, bounded and sanitised. Non-numbers and negatives mean "no hold". */
export function clampHoldMs(raw: unknown): number {
  if ('number' !== typeof raw || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_HOLD_MS);
}
