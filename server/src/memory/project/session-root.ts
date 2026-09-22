import type { ToolDeps } from '@/surface/tools/tool-kit.js';

/**
 * The `.reticle` directory a tool call's artifacts belong in.
 *
 * Every call site that reads or writes a project artifact goes through here, and that is the whole
 * point of the function existing rather than each site asking `deps.artifactRootFor` itself. The
 * write half and the read half MUST agree: a `flow_save` that resolves to the project while
 * `verify_change` still reads the daemon's own directory would be a worse defect than the one being
 * fixed — the flow would save successfully and then be invisible to the tool that exists to replay
 * it, which reads as "no flows covered this change" rather than as an error.
 *
 * Falls back to `deps.reticleRoot` whenever resolution cannot name a project — EXCEPT when the
 * caller named a session that resolves to nothing, which is the one case where the fallback is a
 * wrong answer rather than a cautious one. See `sessionProjectId`.
 */
export function sessionRoot(deps: ToolDeps, sessionId: string | undefined): string {
  const resolver = deps.artifactRootFor;
  if (resolver === undefined) {
    /*
     * With no resolver the answer is `reticleRoot` either way — but the REFUSAL still has to
     * happen, so the lookup is made for its throw and its value discarded. `artifactRootFor?.(…)`
     * short-circuits its own argument, so the unwired path used to skip resolution entirely and
     * hand a named-but-dead session the daemon's directory without ever checking the id. Every
     * embedder of this engine, and every older construction of ToolDeps, is on this branch.
     *
     * Only when an id was actually NAMED, deliberately. With nothing named there is nothing to
     * refuse, and `resolve(undefined)` is not free — it builds the ranked no-session diagnosis and
     * records which branch it took. An unwired caller must cost exactly what it did before.
     */
    if (sessionId !== undefined) sessionProjectId(deps, sessionId);
    return deps.reticleRoot;
  }
  return resolver(sessionProjectId(deps, sessionId)).root;
}

/**
 * The connected session's projectId, or undefined when there is no session to ask.
 *
 * `sessions.resolve` throws for three reasons, and they do not all mean the same thing. Nothing
 * connected, and several connected with none named, both mean "we cannot tell which project this
 * call is about" — on a call that named no session that is not a reason to fail the caller's tool,
 * which may not need a session at all, so it degrades to the daemon's own root.
 *
 * A sessionId that names NO session is the third, and it is a different fact. An agent that passes
 * an id has named the project too, so swallowing that throw does not degrade to a cautious answer:
 * it silently retargets the call at whichever checkout the daemon was started in (#994).
 * The same fallback can expose another project's ledger on reads as well as misdirect writes.
 *
 * So the ambiguous case still declines (the resolver has its own `AMBIGUOUS` branch for the same
 * reason) and the mis-addressed case refuses. There is no root that is right for a dead id, so
 * there is no answer either.
 */
/*
 * Exported alongside `sessionRoot`, and that is the point rather than a convenience. A caller that
 * takes the ROOT from the session and the PROJECT ID from somewhere else has resolved half an
 * address, which is the defect the comment above predicted and `loadNamedFlows` then shipped: it
 * read the id from `readProjectId(process.cwd())` while its root came from here. Both halves come
 * from this file so they cannot disagree again.
 */
export function sessionProjectId(
  deps: ToolDeps,
  sessionId: string | undefined,
): string | undefined {
  try {
    return deps.sessions.resolve(sessionId).projectId;
  } catch (cause) {
    if (sessionId === undefined) return undefined;
    throw unresolvedTargetRefusal(sessionId, cause);
  }
}

/**
 * Why a named-but-dead session gets no directory, and what to do instead.
 *
 * The manager's own message is carried verbatim at the end because it is the actionable half — it
 * names the sessions that ARE connected, with their ids and urls, or says that none are. Rebuilding
 * a worse version of that here is how the two no-session paths drifted apart the last time.
 */
function unresolvedTargetRefusal(sessionId: string, cause: unknown): Error {
  const because = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `sessionId '${sessionId}' names no session, so there is no project to resolve this call's ` +
      '.reticle directory against, and nothing was read or written. Reticle refuses rather than ' +
      "falling back to the daemon's own directory, which belongs to whatever project the daemon " +
      "was started in — that is how one app's intents, flows and runs land in another app's " +
      `checkout. Omit sessionId to use the connected app, or name one that is live. ${because}`,
  );
}
