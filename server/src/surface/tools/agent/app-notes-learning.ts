/**
 * Learning an app note from a corrected failure. Pure: the dispatcher does the disk write.
 *
 * A failed verdict whose diagnosis names the fix — the text is there in another case, the name is on
 * a control with another role — is a CANDIDATE. It becomes a note only when a later passing verdict
 * in the same agent session used that fix. So a note records what worked, never what was guessed.
 *
 * Nothing here can change a verdict: it reads results after they are decided, and its only output
 * is a sentence. See app-notes.ts.
 */
import { Verified, asRecord } from '@reticlehq/core';

interface Candidate {
  /** Present in a later passing call's arguments ⇒ the fix was used. */
  readonly usedWhen: readonly string[];
  readonly note: string;
}

const MAX_PENDING = 10;
const pendingBySession = new Map<string, Candidate[]>();

/** Tests only. */
export function resetAppNoteLearning(): void {
  pendingBySession.clear();
}

/** The verdict block, wherever this tool keeps it (nested on act_and_wait, spread on assert). */
function verdictOf(result: Record<string, unknown>): Record<string, unknown> {
  return 'object' === typeof result['verdict'] && null !== result['verdict']
    ? asRecord(result['verdict'])
    : result;
}

function candidatesIn(result: Record<string, unknown>): Candidate[] {
  const verdict = verdictOf(result);
  const evidence = asRecord(verdict['evidence']);
  const out: Candidate[] = [];
  const shown = evidence['caseMiss'];
  if (true === verdict['caseOnlyMiss'] && 'string' === typeof shown && shown.length > 0) {
    out.push({
      usedWhen: [JSON.stringify(shown).slice(1, -1), '"ignoreCase":true'],
      note: `this app writes "${shown}" — match that case exactly, or use ignoreCase: true where case does not matter`,
    });
  }
  const nearest = evidence['nearestByName'];
  if (Array.isArray(nearest) && nearest.length > 0) {
    const first = asRecord(nearest[0]);
    const name = first['name'];
    const role = first['role'];
    if ('string' === typeof name && name.length > 0) {
      const kind =
        'string' === typeof role && role.length > 0 ? `a ${role}` : 'an element with no role';
      out.push({
        usedWhen: [
          `"label":"${name}"`,
          ...('string' === typeof role && role.length > 0 ? [`"role":"${role}"`] : []),
        ],
        note: `"${name}" is ${kind} here — target it by { label: "${name}" }, not by a guessed role`,
      });
    }
  }
  return out;
}

/**
 * Read one verdict result. Returns a CONFIRMED note to persist, if this call confirmed one.
 * `session` is the agent session (MCP connection); undefined does nothing.
 */
export function learnFromVerdict(
  session: string | undefined,
  args: Record<string, unknown>,
  result: unknown,
): string | undefined {
  if (session === undefined || 'object' !== typeof result || null === result) return undefined;
  const r = result as Record<string, unknown>;
  if (Verified.NO === r['verified']) {
    const found = candidatesIn(r);
    if (found.length > 0) {
      const pending = pendingBySession.get(session) ?? [];
      pendingBySession.set(session, [...pending, ...found].slice(-MAX_PENDING));
    }
    return undefined;
  }
  if (Verified.YES !== r['verified']) return undefined;
  const pending = pendingBySession.get(session);
  if (pending === undefined || 0 === pending.length) return undefined;
  const written = JSON.stringify(args);
  const used = pending.find((c) => c.usedWhen.some((needle) => written.includes(needle)));
  if (used === undefined) return undefined;
  pendingBySession.set(
    session,
    pending.filter((c) => c !== used),
  );
  return used.note;
}
