/**
 * Compare-and-set for flows. Each pushed flow names the platform version it was based on; a push based
 * on a version another machine has since replaced comes back as a conflict carrying the platform's
 * version. This machine then keeps its own edit as a named copy beside the flow and takes the
 * platform's, so nothing is lost and nothing diverges silently. Kept apart from the cycle, which is the
 * protocol; this is the one rule about flow versions.
 */

/** The platform's code for a flow pushed on a version it no longer holds (its HTTP 409). */
export const FLOW_CONFLICT_CODE = 'conflict';

const isRecord = (v: unknown): v is Record<string, unknown> => 'object' === typeof v && null !== v;

/** Versions by name, as kept in the state: only strings count. */
export function versionsIn(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value))
    for (const [name, v] of Object.entries(value)) if ('string' === typeof v) out[name] = v;
  return out;
}

/**
 * What each pending flow was based on: the version last taken here; null for a flow this machine never
 * sent; nothing for one an older client sent without a version (stored unconditionally, as it was).
 */
export function flowBases(
  pending: ReadonlyArray<{ name: string }>,
  versions: Record<string, string>,
  sentHashes: Record<string, string>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const { name } of pending) {
    const v = versions[name];
    if (v !== undefined) out[name] = v;
    else if (sentHashes[name] === undefined) out[name] = null;
  }
  return out;
}

/** A refusal that is a conflict this machine can settle, with the platform's version. */
export function conflictOf(r: {
  code: unknown;
  current: unknown;
}): { version: string; flow: unknown } | undefined {
  const current = isRecord(r.current) ? r.current : undefined;
  const version = current?.['version'];
  return FLOW_CONFLICT_CODE === r.code && 'string' === typeof version
    ? { version, flow: current?.['flow'] }
    : undefined;
}
