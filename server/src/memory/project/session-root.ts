import { dirname } from 'node:path';
import type { ProjectId } from '@reticlehq/core';
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
  // Skip the LOOKUP, never the refusal.
  //
  // `artifactRootFor?.(…)` short-circuits its own argument, so an unwired caller used to skip
  // resolution entirely and hand a named-but-dead session the daemon's own directory without ever
  // checking the id -- which is how one app's intents, flows and runs land in another app's
  // checkout. Resolving as an ARGUMENT fixes that, because arguments are evaluated first.
  //
  // But `resolve(undefined)` is not free: it builds the ranked no-session diagnosis and records
  // which branch it took. With no resolver wired AND no id named there is nothing to refuse and
  // nothing its answer could change, so that one case skips the lookup and costs what it always
  // did. Every embedder of this engine, and every older construction of ToolDeps, is on it.
  const nothingToRefuse = deps.artifactRootFor === undefined && sessionId === undefined;
  return rootForProjectId(deps, nothingToRefuse ? undefined : sessionProjectId(deps, sessionId));
}

/**
 * The same answer for a caller that already holds the projectId rather than a sessionId.
 *
 * The suite paths resolve the project ONCE and thread it down -- the run artifact, the cloud link,
 * the flake ledger and the flows all belong to that one project -- so asking them to go back to the
 * session manager for an id they already have is how a caller ends up taking the root from one
 * place and the id from another. `sessionRoot` is now this function plus a lookup, so the two
 * cannot disagree about what a resolved root is.
 */
export function rootForProjectId(deps: ToolDeps, projectId: ProjectId | undefined): string {
  return deps.artifactRootFor?.(projectId).root ?? deps.reticleRoot;
}

/**
 * The PROJECT directory -- one level above `.reticle` -- for a caller that runs a tool in a tree
 * rather than writing a file into one. `git diff` is the case: it was being run in the daemon's
 * `.reticle` subdirectory, which answers about the wrong repository (or, from a globally-registered
 * daemon at `/` or `$HOME`, about none) while reporting a clean "nothing changed".
 */
export function projectDirFor(deps: ToolDeps, sessionId: string | undefined): string {
  return dirname(sessionRoot(deps, sessionId));
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
): ProjectId | undefined {
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
