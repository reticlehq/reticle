/**
 * The daemon's side of the platform chat: the apps it reports, and the drives it takes.
 *
 * Out of `index.ts`, which only calls this and hands it the cloud credentials (the tool surface does
 * not reach `memory/cloud`; see `withLinkedCredential`): both halves share the same view of which tab is which
 * app, and keeping them together is what stops a drive attached to one app landing in another that
 * happens to be on the same port. See `local-apps.ts` and `remote-drive.ts` for each half.
 */
import { basename, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import type { SessionInfo } from '../../portal/session/session-info.js';
import type { PresenterTone } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
import type { FileSystemPort } from '../../memory/project/fs/fs-port.js';
import { projectDirFor } from '../../memory/project/session-root.js';
import { driveFrame } from '../../features/visual/visual-tools.js';
import { LEASE_ACQUIRE_TOOL } from './lease-tools.js';
import {
  REMOTE_DRIVE_JPEG_QUALITY,
  endDrivenTab,
  pickOwnDriveSession,
  startRemoteDrives,
} from '../../features/harness/platform/remote-drive.js';
import {
  appKeyOf,
  appsByPlatform,
  machineOf,
  pickAppTab,
  startAppReports,
} from '../../features/harness/platform/local-apps.js';
import { serverOptionsFromEnv } from '../../features/harness/platform/server-driver.js';
import { driveForChat } from './explore-tools.js';
import { withLinkedCredential } from './harness-explore.js';
import { runTool } from './invoke-tool.js';

/** The slice of the session manager this needs. */
export interface ChatDriveSessions {
  list(): SessionInfo[];
  count(): number;
  get(id: string): { autoEnd(text: string, tone: PresenterTone): void } | undefined;
}

/** A project's own name: its package's, else its folder's. */
const nameOf = async (fs: FileSystemPort, dir: string): Promise<string> => {
  try {
    const name = (JSON.parse(await fs.readFile(join(dir, 'package.json'))) as { name?: unknown })
      .name;
    if ('string' === typeof name && 0 < name.length) return name;
  } catch {
    // No package, or not JSON: the folder names it.
  }
  return basename(dir) || dir;
};

export interface ChatDriveCloud {
  /** The platform and key a tab's own project is linked with, or undefined when it is not. */
  sessionCloud: (sessionId: string) => Promise<{ url: string; apiKey: string } | undefined>;
  version: string;
}

export function startChatDrives(
  deps: ToolDeps,
  sessions: ChatDriveSessions,
  fs: FileSystemPort,
  cloud: ChatDriveCloud,
  log: (line: string) => void,
): { stop: () => void } {
  const env = process.env;
  const machine = machineOf(hostname(), homedir());
  const sessionCloud = cloud.sessionCloud;
  const sessionKey = async (id: string): Promise<string | undefined> =>
    (await sessionCloud(id))?.apiKey;
  // ponytail: a tab whose project resolves to nothing counts as the daemon's own project here, as it
  // does for flows and runs; a per-tab "unresolved" app is the upgrade if that ever misleads.
  const appOf = (id: string): string | undefined => {
    try {
      return appKeyOf(machine.id, projectDirFor(deps, id));
    } catch {
      return undefined;
    }
  };
  // Opened headless, like `reticle drive <url>`, through runTool so it is counted like any call.
  const open = async (url: string): Promise<void> => {
    await runTool(LEASE_ACQUIRE_TOOL, deps, { url });
  };

  const drives = startRemoteDrives({
    env: () => withLinkedCredential(deps, env),
    connected: () => 0 < sessions.count(),
    pick: (goal, key, app) =>
      undefined === app
        ? pickOwnDriveSession(sessions.list(), goal, key, sessionKey)
        : pickAppTab(app, goal, () => sessions.list(), appOf, open),
    drive: async (goal, sessionId) => {
      const url = sessions.list().find((tab) => tab.sessionId === sessionId)?.url;
      const outcome = await driveForChat(deps, goal, sessionId);
      return url === undefined ? outcome : { ...outcome, url };
    },
    // The leased tab, or a desktop window's own capture. A web tab only the SDK reaches has no camera.
    frame: (sessionId) =>
      sessionId === undefined
        ? Promise.resolve(undefined)
        : driveFrame(deps, sessionId, REMOTE_DRIVE_JPEG_QUALITY),
    settle: (id, outcome) => endDrivenTab(id === undefined ? undefined : sessions.get(id), outcome),
    log,
  });

  const reports = startAppReports({
    machine,
    version: cloud.version,
    apps: async () =>
      appsByPlatform(
        sessions.list(),
        serverOptionsFromEnv(await withLinkedCredential(deps, env)),
        machine.id,
        async (tab) => {
          const dir = projectDirFor(deps, tab.sessionId);
          const platform = await sessionCloud(tab.sessionId);
          return {
            dir,
            name: await nameOf(fs, dir),
            ...(undefined === platform
              ? {}
              : { platform: { url: platform.url.replace(/\/+$/, ''), apiKey: platform.apiKey } }),
          };
        },
      ),
    open,
    drivePending: (platform) => void drives.tick(platform),
    log,
  });
  // Once now, so the chat sees this machine's apps as soon as the daemon is up.
  void reports.tick();

  return {
    stop: () => {
      drives.stop();
      reports.stop();
    },
  };
}
