/**
 * The Harness id each lane of one drive runs under.
 *
 * Lanes in leased contexts used to share the drive's one id, so each lane's session, ending, synced
 * a run under the same `harness-<id>` and the last lane to finish overwrote the others. A lane on
 * its own session gets its own id; a drive that never leased keeps the one id it always had.
 */
export interface LaneIds {
  /** The id for the lane on `sessionId`, minted once and reused. */
  idFor(sessionId: string | undefined): string;
  /** Every id this drive ran under, in the order the lanes started. */
  all(): string[];
}

export function laneIds(harness: string, leasing: boolean): LaneIds {
  const bySession = new Map<string, string>();
  return {
    idFor(sessionId) {
      if (!leasing || sessionId === undefined) return harness;
      const known = bySession.get(sessionId);
      if (known !== undefined) return known;
      const id = `${harness}-L${String(bySession.size + 1)}`;
      bySession.set(sessionId, id);
      return id;
    },
    all: () => (0 < bySession.size ? [...bySession.values()] : [harness]),
  };
}
