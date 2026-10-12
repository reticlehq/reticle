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

/**
 * The url of a window of THIS project already connected to the daemon, if one is.
 *
 * A desktop app with a packaged renderer announces no dev server, so the registry above cannot see
 * it, and setup started the app again beside the running one. On macOS a build signed differently
 * from the installed app is a different app to the keychain, so every start asked for the password
 * again. Scoped to the project the page reported, like the registry: never a sibling's window.
 */
export function connectedAppUrl(
  sessions: readonly { readonly url?: string; readonly projectId?: string }[],
  projectId: string | undefined,
): string | undefined {
  if (projectId === undefined) return undefined;
  const mine = sessions.find((s) => s.projectId === projectId && 0 < (s.url ?? '').length);
  return mine?.url;
}
