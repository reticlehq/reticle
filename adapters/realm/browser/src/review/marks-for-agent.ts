/** The parts of a mark an agent needs to find the element and the code behind it. */
export interface MarkForAgent {
  note: string;
  label: string;
  anchor: string;
  route: string;
  source?: string | undefined;
}

/** How many notes are on the page, as the row beside the copy button says it. */
export function marksCountText(n: number): string {
  return `${String(n)} ${1 === n ? 'note' : 'notes'} on this page`;
}

/**
 * The page's marks as one prompt to paste into an agent.
 *
 * A mark is drained by the agent connected to this page; with none running, the notes would stay
 * on screen and go nowhere. Written for the agent: what is wrong, where to look, and that it should
 * prove the fix in the running app rather than reason about it.
 */
export function marksForAgent(marks: readonly MarkForAgent[], pageUrl: string): string {
  const n = marks.length;
  const head = `I marked ${String(n)} ${1 === n ? 'issue' : 'issues'} on ${pageUrl} with Reticle. Fix each one, then verify it in the running app:`;
  const rows = marks.map((m, i) => {
    const where = m.source === undefined ? m.anchor : `${m.anchor}, ${m.source}`;
    return `${String(i + 1)}. ${m.note}\n   ${m.label} (${where}) on ${m.route}`;
  });
  return [head, '', ...rows].join('\n');
}
