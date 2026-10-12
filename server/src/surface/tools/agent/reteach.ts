/**
 * Re-teach on a mistake the primer covers: ONE line, once per rule per agent session.
 *
 * After a compaction the agent keeps calling, but the rules it read at the start are gone. The daemon
 * still knows it is the same agent (same MCP connection), and it can see the mistake in the call it
 * just answered. So the answer carries the one rule that call broke — and costs nothing when the
 * agent behaves. Deduplication is `foldNotices`' once-per-session rule.
 *
 * Advice only: computed from a result that is already decided, returned as a sentence.
 */
import { ReticleTool, Verified, asRecord } from '@reticlehq/core';

export const ReteachLine = {
  NO_UNTIL:
    'Rule: name the consequence in `until` BEFORE acting — without it the result is "no-fault", which proves nothing.',
  ALIAS:
    'Rule: write predicates in their canonical spelling (see `normalized`); aliases are a courtesy, not the API.',
  CASE: 'Rule: text checks are exact-case — use ignoreCase: true only when the case truly does not matter.',
  RELIST:
    'Rule: you already have this tab — reuse its sessionId (or omit it) instead of listing sessions again.',
  COMPACTED:
    'Lost track (context compacted)? reticle_run { tool: "reticle_context", args: { compact: true } } returns what this session proved, failed and still owes.',
} as const;

const listCounts = new Map<string, number>();

/** Tests only. */
export function resetReteach(): void {
  listCounts.clear();
}

/** The rule this call broke, if any. */
export function reteachFor(
  session: string,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  if (
    ReticleTool.ACT_AND_WAIT === tool &&
    args['until'] === undefined &&
    args['predicate'] === undefined
  ) {
    if (Verified.NO_FAULT === result['verified']) lines.push(ReteachLine.NO_UNTIL);
  }
  if (Array.isArray(result['normalized']) && result['normalized'].length > 0)
    lines.push(ReteachLine.ALIAS);
  const verdict =
    'object' === typeof result['verdict'] && null !== result['verdict']
      ? asRecord(result['verdict'])
      : result;
  if (true === verdict['caseOnlyMiss']) lines.push(ReteachLine.CASE);
  const listing =
    ReticleTool.SESSIONS === tool ||
    (ReticleTool.SESSION === tool && (args['action'] === undefined || 'list' === args['action']));
  if (listing && Array.isArray(result['sessions']) && result['sessions'].length > 0) {
    const seen = (listCounts.get(session) ?? 0) + 1;
    listCounts.set(session, seen);
    // The third listing in one session: the first two are orientation, a third is a lost thread.
    if (seen >= 3) lines.push(ReteachLine.RELIST, ReteachLine.COMPACTED);
  }
  return lines;
}
