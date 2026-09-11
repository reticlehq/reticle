/**
 * Which tab a ref came out of, so the call that spends it cannot be routed to a different one.
 *
 * Reported from the field: three tabs of one project were connected, a snapshot was taken against a
 * named session, and the act that followed omitted `sessionId`. Auto-selection picked a different
 * tab, the ref legitimately did not exist there, and the refusal read "that ref is stale: refs are
 * invalidated whenever the DOM re-renders" — a confident diagnosis of the wrong thing, and one that
 * accuses the app under test. The recovery text then sends the agent to re-snapshot, which mints a
 * fresh ref in whichever tab is chosen next, so the lesson it teaches is wrong either way.
 *
 * The quiet outcome is the worse one. Refs are minted from a per-document block, so the same number
 * is a real, live, DIFFERENT element in the tab that was guessed: the identical call on a luckier day
 * drives the wrong tab and returns a green about a page nobody asked about. That is a false green
 * with extra steps, and it is the failure class this product exists to remove.
 *
 * Every `sessionId` description on the surface already promises that Reticle "refuses rather than
 * guesses when ambiguous". This is the fact that makes the ambiguity visible: the tab a ref was
 * handed out of is known at the moment it is handed out. Resolution is otherwise untouched — a call
 * that names a session, carries no ref, or lands on the tab it looked at resolves silently, which is
 * the cost the surface wording was rewritten to avoid.
 *
 * ponytail: one slot, not a per-ref map. It answers the reported shape — look at one tab, act on
 * what you saw — for the cost of an assignment. A drive that interleaves refs from several tabs
 * inside one turn needs per-ref provenance, and that is the upgrade if it ever shows up.
 */

/** The session the last ref-bearing result was produced from. Undefined until something mints one. */
let mintedIn: string | undefined;

/** Record that a tool handed out refs from this session. */
export function noteRefsMinted(sessionId: string): void {
  mintedIn = sessionId;
}

export function refsLastMintedIn(): string | undefined {
  return mintedIn;
}

/** Test seam: the module holds one slot for the process, so a test has to be able to clear it. */
export function forgetRefProvenance(): void {
  mintedIn = undefined;
}

interface RefRouting {
  /** The ref this call is about to spend, if it carries one. */
  ref: string | undefined;
  /** The `sessionId` the CALLER passed — when present, nothing was guessed. */
  explicitSessionId: string | undefined;
  /** The session resolution actually picked. */
  chosenSessionId: string;
  /**
   * The connected sessions, read ONLY once a refusal is certain. A thunk because listing them walks
   * every session and builds a health block each time, and the answer is wanted on the rare path.
   */
  connected: () => readonly { sessionId: string; url: string }[];
}

/**
 * The refusal for a ref that belongs to another tab, or undefined when there is no ambiguity.
 *
 * Silent when the minting tab is no longer connected: that ref really is dead, and the stale-ref
 * refusal that already exists is the honest answer for it.
 */
export function wrongTabRefusal(routing: RefRouting): string | undefined {
  if (routing.ref === undefined || routing.explicitSessionId !== undefined) return undefined;
  const source = mintedIn;
  if (source === undefined || source === routing.chosenSessionId) return undefined;
  const connected = routing.connected();
  if (!connected.some((s) => s.sessionId === source)) return undefined;
  const listed = connected.map((s) => `'${s.sessionId}' (${s.url})`).join(', ');
  return (
    `ref '${routing.ref}' was handed out by session '${source}', and this call named no sessionId so ` +
    `it resolved to '${routing.chosenSessionId}'. A ref only means something in the tab it was taken ` +
    'in — refs are minted per document, so the same one can point at a different element in another ' +
    'tab — and Reticle refuses rather than guessing which tab you meant. Connected right now: ' +
    `${listed}. Pass sessionId: '${source}' to act on the tab you looked at, or re-read the tab you ` +
    'actually want first. Nothing was driven.'
  );
}
