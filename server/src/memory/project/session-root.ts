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
 * Falls back to `deps.reticleRoot` whenever resolution cannot name a project, which is exactly the
 * behaviour every call site had before the resolver existed.
 */
export function sessionRoot(deps: ToolDeps, sessionId: string | undefined): string {
  return rootForProjectId(deps, sessionProjectId(deps, sessionId));
}

/**
 * The same answer for a caller that already holds the projectId rather than a sessionId.
 *
 * The suite paths resolve the project ONCE and thread it down — the run artifact, the cloud link,
 * the flake ledger and the flows all belong to that one project — so asking them to go back to the
 * session manager for an id they already have is how a caller ends up taking the root from one
 * place and the id from another. `sessionRoot` is now this function plus a lookup, so the two
 * cannot disagree about what a resolved root is.
 */
export function rootForProjectId(deps: ToolDeps, projectId: ProjectId | undefined): string {
  return deps.artifactRootFor?.(projectId).root ?? deps.reticleRoot;
}

/**
 * The PROJECT directory — one level above `.reticle` — for a caller that runs a tool in a tree
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
 * `sessions.resolve` throws when nothing is connected, when the id names no session, and when
 * several are connected and none was named. All three mean the same thing here — we cannot tell
 * which project this call is about — and none of them is a reason to fail the caller's tool.
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
  } catch {
    return undefined;
  }
}
