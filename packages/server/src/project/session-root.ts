import type { ToolDeps } from '../tools/tool-kit.js';

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
  return deps.artifactRootFor?.(sessionProjectIdOf(deps, sessionId)).root ?? deps.reticleRoot;
}

/**
 * The connected session's projectId, or undefined when there is no session to ask.
 *
 * `sessions.resolve` throws when nothing is connected, when the id names no session, and when
 * several are connected and none was named. All three mean the same thing here — we cannot tell
 * which project this call is about — and none of them is a reason to fail the caller's tool.
 */
function sessionProjectIdOf(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    return deps.sessions.resolve(sessionId).projectId;
  } catch {
    return undefined;
  }
}
