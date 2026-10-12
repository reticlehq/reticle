/**
 * The apps of a workspace root and the project each is linked to, for `reticle status` run at a root
 * that is no app of its own: "this repo is not linked" there named nothing that could be acted on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir, asRecord, asString } from '@reticlehq/core';
import { SILENT_HOST, buildNodeIo, findWorkspaceApps } from '@reticlehq/init';

export interface AppLink {
  /** The app's directory, relative to the root. */
  app: string;
  /** The project it sends to, or null when it is not linked. */
  project: string | null;
}

/** Each app under `root`, in name order, with its link. Empty when `root` is no workspace. */
export async function workspaceAppLinks(
  root: string,
  linkOf: (appDir: string) => Promise<string | null>,
): Promise<AppLink[]> {
  let apps: string[];
  try {
    apps = findWorkspaceApps(buildNodeIo(root, SILENT_HOST));
  } catch {
    return [];
  }
  return Promise.all(
    [...apps].sort().map(async (app) => ({ app, project: await linkOf(join(root, app)) })),
  );
}

/** The project an app folder's link file names, or null with none: local only, as status is. */
export function localLinkOf(appDir: string): Promise<string | null> {
  try {
    const link = JSON.parse(
      readFileSync(join(appDir, ReticleDir.ROOT, ReticleDir.CLOUD_LINK_FILE), 'utf8'),
    ) as unknown;
    return Promise.resolve(asString(asRecord(link)['projectId']) ?? null);
  } catch {
    return Promise.resolve(null);
  }
}
