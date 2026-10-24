/**
 * The daemon's side of the platform chat: the apps it reports, and the drives it takes.
 *
 * Out of `index.ts`, which only calls this and hands it the cloud credentials (the tool surface does
 * not reach `memory/cloud`; see `withLinkedCredential`): both halves share the same view of which tab is which
 * app, and keeping them together is what stops a drive attached to one app landing in another that
 * happens to be on the same port. See `local-apps.ts` and `remote-drive.ts` for each half.
 */
import { isUnmatchedRoot } from '@/memory/project/dir/reticle-dir.js';
import { readProjectId } from '@/command/cli/ports/resolve/cli-port.js';
import { basename, dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import type { SessionInfo } from '../../portal/session/session-info.js';
import {
  LinkCapability,
  ReticleDir,
  ReticleTool,
  asRecord,
  type LinkDevServer,
  type PresenterTone,
} from '@reticlehq/core';
import { prepareDrive } from '../../features/harness/platform/drive-target.js';
import { reticleToolset } from './harness-toolset.js';
import type { AttachedApp } from '../../features/harness/platform/remote-drive.js';
import type { ToolDeps } from './tool-kit.js';
import type { FileSystemPort } from '../../memory/project/fs/fs-port.js';
import { projectDirFor, sessionRoot } from '../../memory/project/session-root.js';
import { readDashboardUrl } from '../../memory/project/sync-status.js';
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
  homeRelative,
  machineOf,
  mayOpen,
  NOT_AN_APP_ADDRESS,
  nameFromProjectId,
  pickAppTab,
  startAppReports,
  withoutMarks,
} from '../../features/harness/platform/local-apps.js';
import { serverOptionsFromEnv } from '../../features/harness/platform/server-driver.js';
import { EXPLORE_TOOLS, driveForChat } from './explore-tools.js';
import { harnessStartRefusal, withLinkedCredential } from './harness-explore.js';
import { runTool } from './invoke-tool.js';
import {
  announcedChannels,
  probeMarkers,
  type ProbedTab,
  notApplicableOf,
  recordedGaps,
} from '../../portal/session/recorded-gaps.js';
import { probeDevServers } from '../../portal/session/dev-server/dev-server-probe.js';
import {
  DriveOrigin,
  noteHarnessWord,
  onDriveChange,
  onDriveStep,
  runningDrive,
  stopDrive,
} from '../../features/harness/drive-runs.js';
import {
  FreeDriveKind,
  planUrl,
  requestFreeDrive,
  type FreeDrive,
} from '../../features/harness/platform/platform-drives.js';
import {
  CONNECT_COMMAND,
  HARNESS_NOT_LINKED_HUMAN,
  HumanControlKind,
  type LinkUnsyncedRoot,
} from '@reticlehq/core';
import { onAgentsChange } from '../../hooks/coding-agents.js';

/** Why a platform drive with no tab of its own runs no tool. */
const NO_DRIVEN_TAB = 'No tab was picked for this drive, so no tool runs.';

/** What this daemon does for the platform's chat. Each one is listed only once it is built. */
export const CHAT_CAPABILITIES: readonly LinkCapability[] = [
  LinkCapability.DRIVE_SPEC,
  LinkCapability.TARGET_TAB,
  LinkCapability.TARGET_HEADLESS,
  LinkCapability.TARGET_HEADED,
  LinkCapability.HUD,
  LinkCapability.TOOL_SESSION,
  LinkCapability.FRAMES,
];

/** The slice of the session manager this needs. */
export interface ChatDriveSessions {
  list(): SessionInfo[];
  count(): number;
  get(id: string):
    | {
        autoEnd(text: string, tone: PresenterTone): void;
        pushNarration(text: string): void;
        readonly sdkVersion?: string | undefined;
        readonly channels?: readonly string[] | undefined;
        /** Asks the page what it carries (`probeMarkers`). Absent on a test double. */
        command?: ProbedTab['command'];
        readonly sourceMapping?: boolean | undefined;
      }
    | undefined;
  /** The last page handshake the bridge refused, when there was one. */
  lastClosure?(): { at: number; reason: string } | undefined;
}

/** A project's own name: its package's, else its id's, else its folder's. */
const nameOf = async (
  fs: FileSystemPort,
  dir: string,
  projectId: string | undefined,
): Promise<string> => {
  try {
    const name = (JSON.parse(await fs.readFile(join(dir, 'package.json'))) as { name?: unknown })
      .name;
    if ('string' === typeof name && 0 < name.length) return name;
  } catch {
    // No package, or not JSON: the folder names it.
  }
  // Not mapped to a checkout (the daemon's shared `unmatched` directory): the id the SDK stamped.
  if (undefined !== projectId) return nameFromProjectId(projectId);
  return basename(dir) || dir;
};

export interface ChatDriveCloud {
  /** The platform and key a tab's own project is linked with, or undefined when it is not. */
  sessionCloud: (sessionId: string) => Promise<{ url: string; apiKey: string } | undefined>;
  version: string;
  /** Folders holding runs the platform never got (the sync daemon's last count). Absolute roots. */
  unsynced?: () => readonly { root: string; runs: number; linked: boolean }[];
}

/** How often the localhost dev-server scan may run: never more than this, however often we report. */
const DEV_SERVER_SCAN_EVERY_MS = 30_000;

/**
 * Dev servers listening on localhost with no connected Reticle page — an app that is up and not
 * instrumented, or not dialling. The same probe `doctor` and the no-session diagnosis use, cached.
 */
function devServerScan(
  connectedUrls: () => readonly string[],
  now: () => number,
): () => Promise<LinkDevServer[]> {
  let last: { at: number; ports: number[] } | undefined;
  return async () => {
    if (last === undefined || now() - last.at >= DEV_SERVER_SCAN_EVERY_MS)
      last = { at: now(), ports: await probeDevServers() };
    const connected = new Set(
      connectedUrls().map((url) => {
        try {
          return Number(new URL(url).port);
        } catch {
          return 0;
        }
      }),
    );
    return last.ports
      .filter((port) => !connected.has(port))
      .map((port) => ({ url: `http://${LOCALHOST_HOST}:${String(port)}`, port }));
  };
}

const LOCALHOST_HOST = 'localhost';

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
      const projectId = sessions.list().find((tab) => tab.sessionId === id)?.projectId;
      return appKeyOf(machine.id, projectDirFor(deps, id), projectId);
    } catch {
      return undefined;
    }
  };
  // Opened headless, like `reticle drive <url>`, through runTool so it is counted like any call.
  const openable = (url: string): void => {
    if (
      !mayOpen(
        url,
        sessions.list().map((tab) => tab.url),
      )
    )
      throw new Error(NOT_AN_APP_ADDRESS);
  };
  /**
   * The `.reticle` each reported app writes into, learned from its tabs. A tab the chat opens for an
   * app is leased into that root: resolved from the page alone, an app with no project id would land
   * in `unmatched/`, which nothing syncs.
   */
  const rootByApp = new Map<string, { root: string; projectId?: string }>();
  /**
   * The root AND the project a tab the daemon opens for an app is stamped with. Stamped with the
   * root alone, a page that reports no project of its own opened as nobody's: its run fell to
   * `unmatched/` and the drive answered a linked project "run reticle connect".
   */
  const claimFor = (appKey: string | undefined): { root?: string; projectId?: string } =>
    (appKey === undefined ? undefined : rootByApp.get(appKey)) ?? {};
  /** Where each credential's project was last open on this machine, from the reports. */
  const lastUrlByKey = new Map<string, { url: string; root: string; projectId?: string }>();
  /** Lease the app a credential's project was last open at, for a drive no tab of it can take. */
  const reopenFor = async (key: string): Promise<string | undefined> => {
    const last = lastUrlByKey.get(key);
    if (last === undefined) return undefined;
    openable(last.url);
    const id = asRecord(await runTool(LEASE_ACQUIRE_TOOL, deps, { ...last }))['sessionId'];
    return 'string' === typeof id ? id : undefined;
  };
  const open = async (url: string, appKey?: string): Promise<void> => {
    openable(url);
    await runTool(LEASE_ACQUIRE_TOOL, deps, { url, ...claimFor(appKey) });
  };

  const pick = (
    goal: string,
    key: string,
    app: AttachedApp | undefined,
  ): Promise<string | null | undefined> =>
    undefined === app
      ? pickOwnDriveSession(sessions.list(), goal, key, sessionKey, () => reopenFor(key))
      : pickAppTab(
          app,
          goal,
          () => sessions.list(),
          appOf,
          (url) => open(url, app.key),
        ).then(async (id) =>
          // The app the platform named must be one this credential's project owns.
          'string' === typeof id && (await sessionKey(id)) !== key ? null : id,
        );
  const drives = startRemoteDrives({
    env: () => withLinkedCredential(deps, env),
    connected: () => 0 < sessions.count(),
    pick,
    // The spec's target and HUD, applied through the same counted tools an agent would call.
    prepare: ({ goal, apiKey, app, spec }) =>
      prepareDrive(spec, app?.url ?? undefined, {
        pickTab: () => pick(goal, apiKey, app),
        open: async (url, headed, hud) => {
          openable(url);
          const lease = asRecord(
            await runTool(LEASE_ACQUIRE_TOOL, deps, {
              url,
              ...(headed ? { headed } : {}),
              ...(hud === undefined ? {} : { hud }),
              ...claimFor(app?.key),
            }),
          );
          const id = lease['sessionId'];
          if ('string' !== typeof id) throw new Error(`could not open ${url}`);
          return id;
        },
        tuneHud: async (sessionId, hud) => {
          await reticleToolset(deps, { sessionId }).invoke(ReticleTool.SESSION_TUNE, { hud });
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    // A platform drive: Reticle's own tools on the driven tab, and nothing else. Locked, so a call
    // naming another tab still lands on this one; with no tab picked, nothing runs at all.
    session: (sessionId) => {
      if (sessionId === undefined)
        return { invoke: () => Promise.reject(new Error(NO_DRIVEN_TAB)) };
      const tools = reticleToolset(deps, { sessionId, locked: true });
      return { tools: tools.tools, invoke: (tool, args) => tools.invoke(tool, args) };
    },
    drive: async (goal, sessionId, spec) => {
      const url = sessions.list().find((tab) => tab.sessionId === sessionId)?.url;
      const outcome = await driveForChat(deps, goal, sessionId, spec?.plan, spec?.confirmDangerous);
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

  const scanDevServers = devServerScan(
    () => sessions.list().map((tab) => tab.url),
    () => Date.now(),
  );
  const reports = startAppReports({
    machine,
    version: cloud.version,
    capabilities: CHAT_CAPABILITIES,
    apps: async () => {
      // The setup score the dashboard shows is what the app's pages carry, asked of each page
      // until its app has shown both markers: never only what an act happened to reach.
      await probeMarkers(
        sessions.list().flatMap((tab) => {
          const live = sessions.get(tab.sessionId);
          const command = live?.command?.bind(live);
          return command === undefined
            ? []
            : [{ id: tab.sessionId, url: tab.url, projectId: tab.projectId, command }];
        }),
      );
      return appsByPlatform(
        sessions.list().map((tab) => {
          const live = sessions.get(tab.sessionId);
          const sdkVersion = live?.sdkVersion;
          // What the page announced plus the gaps its verdicts paid for: what the dashboard's
          // coverage line and coding-agent prompt are built from.
          const channels = announcedChannels({
            id: tab.sessionId,
            url: tab.url,
            projectId: tab.projectId,
            channels: live?.channels,
            sourceMapping: live?.sourceMapping,
          });
          const gaps = recordedGaps(tab.sessionId).map(({ kind, missing, fix, seenAt }) => ({
            kind,
            missing,
            fix,
            seenAt,
          }));
          return {
            ...tab,
            ...(sdkVersion === undefined ? {} : { sdkVersion }),
            ...(0 === channels.length ? {} : { channels }),
            gaps,
            notApplicable: notApplicableOf({
              id: tab.sessionId,
              url: tab.url,
              projectId: tab.projectId,
            }),
          };
        }),
        serverOptionsFromEnv(await withLinkedCredential(deps, env)),
        machine.id,
        async (tab) => {
          const root = sessionRoot(deps, tab.sessionId);
          const dir = dirname(root);
          const projectId = tab.projectId ?? readProjectId(dir);
          const stamp = { root, ...(projectId === undefined ? {} : { projectId }) };
          rootByApp.set(appKeyOf(machine.id, dir, tab.projectId), stamp);
          const platform = await sessionCloud(tab.sessionId);
          if (undefined !== platform)
            lastUrlByKey.set(platform.apiKey, { url: withoutMarks(tab.url), ...stamp });
          return {
            dir,
            name: await nameOf(fs, dir, tab.projectId),
            ...(undefined === platform
              ? {}
              : { platform: { url: platform.url.replace(/\/+$/, ''), apiKey: platform.apiKey } }),
          };
        },
      );
    },
    open,
    extras: async () => {
      const closure = sessions.lastClosure?.();
      const unsynced = cloud.unsynced?.();
      return {
        devServers: await scanDevServers(),
        ...(closure === undefined
          ? {}
          : { helloFailure: { reason: closure.reason, at: closure.at } }),
        ...unsyncedReport(unsynced, homedir()),
      };
    },
    drivePending: (platform) => void drives.tick(platform),
    // What the platform wants the person told: in the daemon's log, and on the HUD of each open tab
    // of that project, so somebody who never reads the log still sees "update Reticle".
    notify: (notice, platform) => {
      const line = `${notice.text}${notice.url === undefined ? '' : ` ${notice.url}`}`;
      log(`reticle: from the platform: ${line}`);
      void (async () => {
        for (const tab of sessions.list()) {
          const key = await sessionKey(tab.sessionId).catch(() => undefined);
          if (key === platform.apiKey) sessions.get(tab.sessionId)?.pushNarration(line);
        }
      })();
    },
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

/** The dashboard the tab's project is linked to, when its link names one. */
function dashboardOf(deps: ToolDeps, sessionId: string): string | undefined {
  try {
    return readDashboardUrl(sessionRoot(deps, sessionId));
  } catch {
    return undefined;
  }
}

/** Said on the HUD when Link this project ends. */
const MSG_LINKED = 'Linked. This project now reports to your dashboard.';
const MSG_LINK_FAILED = 'Could not link this project. Run `reticle connect` in its folder.';
/** A page with no projectId: linking it would bind a hash-named project nothing here reads. */
const MSG_LINK_NEEDS_PROJECT =
  'This page did not say which project it is, so there is nothing to link yet. Run `npx @reticlehq/server init` in your app (or pass `projectId` to `connect()`), then Link.';
const MSG_LINK_UNAVAILABLE = `This Reticle cannot link from the panel. Run \`${CONNECT_COMMAND}\` in the project folder.`;
/** Said on the HUD when Stop finds nothing to stop. */
const MSG_NOTHING_DRIVING = 'No Harness drive is running in this tab.';
const msgStartTrial = (url: string): string => `Start your trial: ${url}`;

/**
 * The panel's Harness controls. The switch is the platform's autonomous mode, unchanged. Run Harness
 * and Stop drive. A run asks the platform for the drive's grant, then starts it
 * through the same explore an agent calls (counted, recorded, polled the same way); its lines and
 * steps reach the HUD log as the drive narrates them. A refused grant says why, and where to start
 * a trial when it wants a card.
 */
export async function hudDrive(
  deps: ToolDeps,
  sessionId: string,
  /** The panel's control, as the bridge narrowed it (`harness-request.ts`). */
  request:
    | { kind: typeof HumanControlKind.HARNESS; enabled: boolean }
    | { kind: typeof HumanControlKind.HARNESS_RUN; persona?: string }
    | { kind: typeof HumanControlKind.HARNESS_STOP },
  /** The autonomous switch: written through to the platform, which the daemon owns. */
  applySwitch: (enabled: boolean) => void,
  grant: (platform: { url: string; apiKey: string }) => Promise<FreeDrive> = (platform) =>
    requestFreeDrive(platform, FreeDriveKind.EXPLORE),
): Promise<void> {
  if (HumanControlKind.HARNESS === request.kind) return applySwitch(request.enabled);
  // What the panel's Run and Stop answer belongs in the Harness log, and in the Agent Log as a summary.
  const said: string[] = [];
  const say = (text: string): void => {
    said.push(text);
    deps.sessions.get?.(sessionId)?.pushNarration(text, true, { harness: true, summary: true });
  };
  if (HumanControlKind.HARNESS_STOP === request.kind) {
    const running = runningDrive(sessionId);
    if (running === undefined || !stopDrive(running.harnessRun)) say(MSG_NOTHING_DRIVING);
    return;
  }
  // Whatever stops a run before it drives is said on the Run row too, not only in the log: with the
  // cloud unreachable, Run went to Starting… and back with no word on the page.
  try {
    await startHudRun(deps, sessionId, request, say, grant);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
  } finally {
    if (0 < said.length) noteHarnessWord(sessionId, said.join(' '));
  }
}

/** Run Harness: the build check, the platform's grant, then the drive, saying why at each refusal. */
async function startHudRun(
  deps: ToolDeps,
  sessionId: string,
  request: { kind: typeof HumanControlKind.HARNESS_RUN; persona?: string },
  say: (text: string) => void,
  grant: (platform: { url: string; apiKey: string }) => Promise<FreeDrive>,
): Promise<void> {
  // Before the grant: a drive refused for version skew must not take one.
  const env = await withLinkedCredential(deps, process.env, { sessionId });
  const locked = await harnessStartRefusal(deps, sessionId);
  if (locked !== undefined) return say(locked.text.split('\n')[0] ?? locked.text);
  const platform = serverOptionsFromEnv(env);
  // The person's sentence: the agent's (`MSG_NO_HARNESS_KEY`) names tools they never call.
  if (platform === undefined) return say(HARNESS_NOT_LINKED_HUMAN);
  const granted = await grant(platform);
  if (!granted.granted) {
    say(granted.message);
    // At the console's origin (the tab's link names it), never the API's, which 404s when split.
    if (granted.needsCard)
      say(msgStartTrial(planUrl(dashboardOf(deps, sessionId) ?? platform.url)));
    return;
  }
  const explore = EXPLORE_TOOLS.find((tool) => ReticleTool.VERIFY_EXPLORE === tool.name);
  if (explore === undefined) return;
  await runTool(explore, deps, {
    sessionId,
    driveId: granted.driveId,
    origin: DriveOrigin.HUD,
    wait: 0,
    ...(request.persona === undefined ? {} : { persona: request.persona }),
  });
}

/**
 * The link a panel sign-in makes once it lands: the tab's project, never a page that did not say
 * which project it is (that would bind a hash-named project nothing here reads).
 */
export function projectLinkOnly(
  link: ((root: string) => Promise<number>) | undefined,
): ((root: string) => Promise<number>) | undefined {
  return link === undefined
    ? undefined
    : (root) => (isUnmatchedRoot(root) ? Promise.resolve(0) : link(root));
}

/**
 * The panel's Harness controls on a bridge: the switch writes through to the platform, so console
 * and panel cannot disagree; Run and Stop drive, in the project of the tab that asked.
 */
export function attachHudHarness(
  bridge: {
    attachHarnessRequest(
      handler: (
        request: Parameters<typeof hudDrive>[2] | { kind: typeof HumanControlKind.HARNESS_LINK },
        session: { id: string; artifactRoot?: string | undefined },
      ) => void,
    ): void;
  },
  daemon: {
    /** Read when a control arrives: the daemon builds its deps after it wires the bridge. */
    deps: () => ToolDeps;
    /** Where a tab with no project of its own drives. */
    root: string;
    /** Repaint every panel, so a running drive shows its Stop button and a finished one hides it. */
    repaint: () => void;
  },
  applySwitch: (root: string, on: boolean) => void,
  /** Link this project: what `reticle connect` does from that folder. Absent: the button says so. */
  link?: (root: string) => Promise<number>,
): void {
  bridge.attachHarnessRequest((request, s) => {
    const root = s.artifactRoot ?? daemon.root;
    if (HumanControlKind.HARNESS_LINK === request.kind) {
      // On the Harness page, where Link was pressed, and in the Agent Log. Said only in the log, a
      // refusal left the page saying "Linking…" and nothing else.
      const say = (text: string): void =>
        daemon
          .deps()
          .sessions.get?.(s.id)
          ?.pushNarration(text, true, { harness: true, summary: true });
      const refuse = (text: string): void => {
        say(text);
        daemon.repaint();
      };
      if (link === undefined) return refuse(MSG_LINK_UNAVAILABLE);
      if (isUnmatchedRoot(root)) return refuse(MSG_LINK_NEEDS_PROJECT);
      void link(root)
        .then((code) => say(0 === code ? MSG_LINKED : MSG_LINK_FAILED))
        .catch(() => say(MSG_LINK_FAILED))
        .finally(daemon.repaint);
      return;
    }
    // Repainted after, so a refusal said on the Run row shows without waiting for another push.
    void hudDrive(daemon.deps(), s.id, request, (on) => applySwitch(root, on)).finally(
      daemon.repaint,
    );
  });
  onDriveChange(daemon.repaint);
  // Each step too, so the panel's "N steps so far" counts up instead of sitting at zero.
  onDriveStep(daemon.repaint);
  // And "Connected: Claude Code" follows an agent attaching or leaving.
  onAgentsChange(daemon.repaint);
}

/**
 * The `unsynced` field of a report. Sent empty too, once this daemon has counted: the platform reads
 * an absent list as "no news" and kept a "never sent" banner for runs that had long been sent.
 */
export function unsyncedReport(
  unsynced: readonly LinkUnsyncedRoot[] | undefined,
  home: string,
): { unsynced?: LinkUnsyncedRoot[] } {
  if (unsynced === undefined) return {};
  return {
    // A folder no project claimed cannot be connected, so no board should tell anyone to.
    unsynced: unsynced
      .filter((u) => !isUnmatchedRoot(u.root))
      .map((u) => ({
        ...u,
        // The project, not its `.reticle`: the dashboard tells the person to run a command there.
        root: homeRelative(ReticleDir.ROOT === basename(u.root) ? dirname(u.root) : u.root, home),
      })),
  };
}
