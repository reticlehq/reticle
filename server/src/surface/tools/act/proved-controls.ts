import { Verified } from '@reticlehq/core';

/**
 * Remember the control an act_and_wait PROVED, for the coverage ledger's `proved` level.
 *
 * Structural rather than `Session`, and optional, so a test stub that never proves anything need not
 * implement it — the same reason `beginAction` is optional on the crawl session.
 */
export function noteProved(
  session: { recordProvedFrom?: (actPayload: unknown) => void },
  verified: string,
  actPayload: unknown,
): void {
  if (Verified.YES === verified) session.recordProvedFrom?.(actPayload);
}
