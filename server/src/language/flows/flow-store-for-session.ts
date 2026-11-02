/**
 * The flow store a SESSION's flows belong in.
 *
 * `deps.flows` is bound to the daemon's own root at construction, which is right only when the
 * daemon happens to have been started in the project it is driving. A user-scoped MCP registration
 * is the common case and the editor starts it wherever it likes, so "where the daemon was launched"
 * and "which app is being verified" are usually different directories.
 *
 * This used to live inside flow-tools and was applied at exactly ONE of ten call sites. The result
 * is the half-applied state `sessionRoot` warns about in its own comment, reached in practice:
 *
 *   - the HUD listed the daemon repo's flows while driving somebody else's app — Electron and Tauri
 *     flows shown over a React dashboard, none of which existed in the checkout being verified
 *   - `flow_replay` answered `flow_not_found` for a flow sitting on disk, because it looked in the
 *     daemon's root while `reticle verify` (which roots itself at cwd) replayed the same flow fine
 *   - and the two save paths disagreed with each other, so where a flow landed depended on which
 *     tool wrote it
 *
 * Reported as "running the daemon from here but taking the directory from there", which is exactly
 * what it was.
 *
 * Rebinding is cheap — a FlowStore is a filesystem port, a root and a clock — and the common case
 * allocates nothing: when no resolver is wired, or it names the root already in use, `deps.flows` is
 * returned unchanged.
 */
import { dirname } from 'node:path';
import { FlowStore } from './flows.js';
import type { NamedFlow } from './change/flow-sources.js';
import { rootForTarget, sessionTarget, type ProjectTarget } from '@/memory/project/session-root.js';
import { isUnmatchedRoot } from '@/memory/project/dir/reticle-dir.js';
import type { ProjectId } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

export function flowsForSession(
  deps: ToolDeps,
  target: ProjectTarget,
): { flows: FlowStore; root: string } {
  // Through `rootForTarget`, so the root a lease claimed wins here as it does for runs. Without
  // it a lease from one folder replayed the flows of the folder the daemon was started in.
  const root = rootForTarget(deps, target);
  if (root === deps.reticleRoot) {
    return { flows: deps.flows, root: deps.reticleRoot };
  }
  const onWrote = deps.onRunPersisted;
  return {
    flows: new FlowStore(
      deps.fs,
      root,
      { now: deps.now },
      onWrote === undefined ? {} : { onWrote },
    ),
    root,
  };
}

/** `flowsForSession` for a session id, with the project id to scope the store by. Same refusals. */
export function flowsForSessionId(
  deps: ToolDeps,
  sessionId: string | undefined,
): { flows: FlowStore; root: string; projectId: ProjectId | undefined } {
  const target = sessionTarget(deps, sessionId);
  return { ...flowsForSession(deps, target), projectId: target.projectId };
}

/** The {name, steps} of every flow in `store` that `projectId` can see. Unreadable flows are left out. */
export async function namedFlowsIn(
  store: FlowStore,
  projectId: ProjectId | undefined,
): Promise<NamedFlow[]> {
  const flows: NamedFlow[] = [];
  for (const name of await store.list(projectId)) {
    const loaded = await store.load(name, projectId);
    if (loaded.ok) {
      flows.push({ name: loaded.value.name, steps: loaded.value.steps });
    }
  }
  return flows;
}

/**
 * The saved flows of a session, from the store `flowsForSessionId` resolves, and the project
 * directory that holds that store.
 *
 * `affected` and `change` read flows through here, and `flows` replays from the same store. They
 * used to build their own store from `sessionRoot`, which skips the root a lease claimed when no
 * resolver is wired and no session is named. Then `affected` named a flow that `flows` could not
 * find (#1996). The directory is returned too, so `git diff` runs in the tree the flows belong to.
 *
 * `sessionTarget` declines when several projects are connected and none is named, because a caller
 * that needs no session must still work. These callers answer about ONE project, and that fallback
 * is the daemon's own, so its flows read as the driven tab's (#1550). Here the refusal stands:
 * `resolve` names the connected projects and asks for a `sessionId`. It throws nothing for several
 * tabs of one project, or for no session at all.
 *
 * `unmatchedRoot` is set when the project has no folder: the root is an evidence bucket, not a
 * tree, so there is no `git` to ask and no flows to find.
 */
export async function namedFlowsForSession(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<{ flows: NamedFlow[]; projectDir: string; unmatchedRoot?: string }> {
  // Older constructions of ToolDeps carry no session manager, as `sessionRoot` notes.
  const sessions = deps.sessions as Partial<ToolDeps['sessions']> | undefined;
  if (sessionId === undefined && 1 < (sessions?.count?.() ?? 0)) {
    deps.sessions.resolve(undefined);
  }
  const { flows: store, root, projectId } = flowsForSessionId(deps, sessionId);
  return {
    flows: await namedFlowsIn(store, projectId),
    projectDir: dirname(root),
    ...(isUnmatchedRoot(root) ? { unmatchedRoot: root } : {}),
  };
}
