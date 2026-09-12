import { devServersForProject, type DevServerEntry } from '@reticlehq/core';

/**
 * The URL of a live dev server that belongs to THIS project, if one has announced itself.
 *
 * Setup used to ignore the registry and spawn `dev` anyway. Vite then bound the next port (5174)
 * beside the one already serving (5173), and `reticle_sessions` listed three tabs with no way to
 * pick. The registry is scoped on purpose: an unscoped read would attach to a sibling app.
 */
export function urlOfExistingApp(
  entries: readonly DevServerEntry[],
  scope: { projectId?: string | undefined; root?: string | undefined },
): string | undefined {
  const mine = devServersForProject(entries, scope);
  const first = mine[0];
  return first === undefined ? undefined : first.url;
}
