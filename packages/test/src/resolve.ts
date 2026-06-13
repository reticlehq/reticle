import { IrisTool, type ToolInvoker } from '@syrin/iris-server';
import { QueryBy } from '@syrin/iris-protocol';
import { IrisQueryEmptyError } from './skip.js';
import { NO_ELEMENT_FOR_TESTID } from './constants.js';

/** Shape of the iris_query envelope the façade consumes (a narrowed view of QueryResult). */
interface QueryEnvelope {
  elements?: { ref?: unknown }[];
  hint?: { presentTestids?: unknown };
}

function asQueryEnvelope(value: unknown): QueryEnvelope {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const elements = Array.isArray(record['elements'])
    ? (record['elements'] as { ref?: unknown }[])
    : undefined;
  const hint =
    typeof record['hint'] === 'object' && record['hint'] !== null
      ? (record['hint'] as { presentTestids?: unknown })
      : undefined;
  return {
    ...(elements !== undefined ? { elements } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/**
 * The single testid -> ref chokepoint. Queries by testid; returns the first ref. On zero matches
 * throws IrisQueryEmptyError naming the testid, carrying the query's presentTestids as evidence so
 * the runner surfaces "you meant one of these" instead of a blank failure.
 */
export async function resolveTestid(
  invoke: ToolInvoker,
  testid: string,
  sessionId?: string,
): Promise<string> {
  const args: Record<string, unknown> = {
    by: QueryBy.TESTID,
    value: testid,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  const result = asQueryEnvelope(await invoke(IrisTool.QUERY, args));
  const first = result.elements?.[0]?.ref;
  if (typeof first === 'string' && first.length > 0) return first;

  const present = result.hint?.presentTestids;
  const detail = present !== undefined ? { evidence: { presentTestids: present } } : undefined;
  throw new IrisQueryEmptyError(`${NO_ELEMENT_FOR_TESTID} ${testid}`, detail);
}
