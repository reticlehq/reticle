/**
 * What `reticle-computer-use` needs to join a bridge: which application, which bridge, the token
 * of that bridge, and the folders to watch. Pure, so a test gives it arguments and files.
 */
import { basename, join } from 'node:path';

import { RETICLE_DEFAULT_PORT, bridgeWsUrl } from '@reticlehq/core';

const Flag = {
  APP: '--app',
  PORT: '--port',
  WATCH: '--watch',
  PROJECT: '--project',
  NO_ELECTRON_SWITCH: '--no-electron-switch',
  LIST: '--list',
  BACKGROUND_ONLY: '--background-only',
  NO_HUD: '--no-hud',
  OPEN: '--open',
} as const;
const Env = {
  TOKEN: 'RETICLE_TOKEN',
  PORT: 'RETICLE_PORT',
  TOKEN_DIR: 'RETICLE_PAIRING_TOKEN_DIR',
} as const;
const STATE_DIR = '.reticle';
const TOKEN_FILE = 'pairing-token';

/** The file that ties a folder to a project. `reticle init` writes it. */
const PROJECT_FILE = '.reticle.json';

function projectIdIn(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const id =
      'object' === typeof parsed && parsed !== null && 'projectId' in parsed
        ? parsed.projectId
        : undefined;
    return 'string' === typeof id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface AttachPlan {
  app: string;
  url: string;
  /** Absent when the bridge has no token file. A bridge with a token then refuses the dial. */
  token?: string;
  watch: string[];
  /**
   * The project the application belongs to, from the `.reticle.json` in the folder that
   * `--project` names. Absent: no folder was named, which is the usual case: a desktop
   * application is driven for itself, and it is in no project. The command does NOT take the
   * project of the folder it runs in: a browser tab of that project would then share its scope,
   * and a call with no sessionId that was meant for the page could go to the application. The runs and flows of the session then go to
   * a folder for sessions with no project, and they do not reach the dashboard.
   */
  projectId?: string;
  /**
   * Turn on the accessibility switch of an Electron application, and turn it off at the end.
   * With the switch off, an Electron application shows its elements and does nothing for a press.
   * On unless the person says `--no-electron-switch`: the switch costs that application some
   * speed, and an agent that joins one must not have to know about it.
   */
  electronSwitch: boolean;
  /**
   * The realm may bring the application to the front and use the real pointer, when a caller asks
   * for it on an action. False with `--background-only`: the person at the machine keeps the
   * pointer and the application in front, whatever a caller asks.
   */
  foreground: boolean;
  /**
   * Show the realm's own pointer and its small window on the screen. False with `--no-hud`: a
   * machine with nobody at it has no use for them.
   */
  hud: boolean;
  /**
   * Start the application when it is not open, and then join it. False unless the caller says
   * `--open`: a command that joins must not start a program that nobody asked for.
   */
  open: boolean;
}

export function attachPlan(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  readFile: (path: string) => string | undefined,
): AttachPlan | { error: string } {
  const valuesOf = (flag: string): string[] =>
    argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ''] : []));
  const app = valuesOf(Flag.APP)[0];
  if (app === undefined || 0 === app.length) {
    return {
      error: `Name the application: ${Flag.APP} <name>. To see the names that are open: ${Flag.LIST}.`,
    };
  }
  const folder = valuesOf(Flag.PROJECT)[0];
  let projectId: string | undefined;
  if (folder !== undefined) {
    projectId = projectIdIn(readFile(join(folder, PROJECT_FILE)));
    if (projectId === undefined) {
      return {
        error: `${join(folder, PROJECT_FILE)} has no projectId. Run \`reticle init\` in that folder, or give the folder of the application's source.`,
      };
    }
  }
  const port = Number(valuesOf(Flag.PORT)[0] ?? env[Env.PORT] ?? RETICLE_DEFAULT_PORT);
  const token =
    env[Env.TOKEN] ??
    readFile(join(env[Env.TOKEN_DIR] ?? join(home, STATE_DIR), TOKEN_FILE))?.trim();
  return {
    app,
    url: bridgeWsUrl(port),
    ...(token === undefined || 0 === token.length ? {} : { token }),
    watch: valuesOf(Flag.WATCH),
    ...(projectId === undefined ? {} : { projectId }),
    electronSwitch: !argv.includes(Flag.NO_ELECTRON_SWITCH),
    foreground: !argv.includes(Flag.BACKGROUND_ONLY),
    hud: !argv.includes(Flag.NO_HUD),
    open: argv.includes(Flag.OPEN),
  };
}

/** The file that every Electron application has in its bundle. */
const ELECTRON_MARK = 'Contents/Frameworks/Electron Framework.framework';
/**
 * Frameworks that carry Chromium with no Electron: the embedded framework (Spotify), and the one
 * of Arc and Dia. Read from the bundles; only Chrome and Electron were driven.
 */
const CHROMIUM_MARKS = [
  'Contents/Frameworks/Chromium Embedded Framework.framework',
  'Contents/Frameworks/ArcCore.framework',
];
const BUNDLE = /^(.*?\.app)\//;

/**
 * True when the program of a process is in the bundle of an Electron application or of a
 * Chromium browser. Both show a page, and both need the accessibility switch: without it a press
 * on the page is answered with "done" and does not reach the page.
 *
 * A Chromium browser has no Electron in it. Its mark is a framework with the name of its own
 * program: `Google Chrome Framework.framework` beside the program `Google Chrome`.
 */
export function isElectron(given: string, exists: (path: string) => boolean): boolean {
  // A program as `ps` gives it ends with a newline, and the name of the program is part of a mark.
  const program = given.trim();
  const bundle = BUNDLE.exec(program)?.[1];
  if (bundle === undefined) {
    return false;
  }
  const name = basename(program);
  return [ELECTRON_MARK, ...CHROMIUM_MARKS, `Contents/Frameworks/${name} Framework.framework`].some(
    (mark) => exists(join(bundle, mark)),
  );
}

/**
 * What to say when an Electron application is joined with its switch off. `program` is the path
 * of the program of the process. Absent answer: the application is not Electron, or the switch
 * is on.
 */
export function electronWarning(
  program: string,
  plan: Pick<AttachPlan, 'app' | 'electronSwitch'>,
  exists: (path: string) => boolean,
): string | undefined {
  if (plan.electronSwitch || !isElectron(program, exists)) {
    return undefined;
  }
  return `${plan.app} is an Electron application. It shows its elements, and it does NOTHING for a press while its accessibility switch is off. Run again without ${Flag.NO_ELECTRON_SWITCH}: the switch is then set, and it is set back when you stop.`;
}

/**
 * What the command says on standard output when it has joined: one line of JSON, for an agent
 * that started it. `sessionId` is needed on a tool call only when the session is in no project:
 * a session in the project of the folder is found without it.
 */
export function joinedAnswer(
  plan: Pick<AttachPlan, 'app' | 'projectId' | 'foreground'>,
  sessionId: string,
  pid: number,
  seen?: { windows: number; windowsNotOnScreen: number },
): Record<string, unknown> {
  const inProject = plan.projectId !== undefined;
  const away = seen !== undefined && 0 === seen.windows && seen.windowsNotOnScreen > 0;
  const bring = plan.foreground
    ? `Send the action \`focus\` on the line of the application with args: { foreground: true }. It brings ${plan.app} to the front, and the screen of the person goes to it.`
    : `Ask the person at the machine to bring ${plan.app} to the Space in front.`;
  const session = inProject ? '' : `, sessionId: "${sessionId}"`;
  return {
    joined: true,
    app: plan.app,
    pid,
    sessionId,
    needsSessionId: !inProject,
    foreground: plan.foreground,
    ...(away
      ? {
          readable: false,
          why: `The window of ${plan.app} is on another Space or made small, and the operating system gives no elements there. ${bring}`,
        }
      : {}),
    next: [
      `reticle_look { action: "page"${session} } gives the window as lines with refs.`,
      `reticle_act_and_wait { ref, action, until${session} } acts and proves the consequence in one call.`,
      'Actions: click, fill, type, press, clear, check, uncheck, select, submit, scroll. With args.foreground: true also dblclick, hover, drag, focus and a real click.',
      'Prefer a signal for `until` when the action writes a file or changes a setting: file.written, disk.wrote, settings.changed, clipboard.changed.',
    ],
  };
}

/** One application that is open, as the helper lists it. */
export interface RunningApp {
  /** The name a person sees in the Dock and the menu bar. */
  name: string;
  /** The name of the program of the process. */
  process: string;
  pid: number;
  /** When it was started, in seconds. Absent: not known. */
  launched?: number;
  /** An application a person opens, with a place in the Dock. Absent: not known. */
  regular?: boolean;
}

/** The names a refusal gives when nothing is near the name that was asked for. */
const NAMES_GIVEN = 12;

/**
 * The application a person means by a name. The name a person sees is often not the name of the
 * process: "Visual Studio Code" runs as "Code". A name that fits nothing gets the names that are
 * near it, or the names of what is open.
 */
export function pickApp(
  wanted: string,
  running: readonly RunningApp[],
): { pid: number } | { error: string } {
  const fold = (text: string): string => text.toLowerCase();
  const is = (app: RunningApp, same: (a: string, b: string) => boolean): boolean =>
    same(app.name, wanted) || same(app.process, wanted);
  // Of several with the same name, the one that was started last: it is the one a person just
  // opened, and an old one can be an application that is ending.
  const newest = [...running].sort((a, b) => (b.launched ?? 0) - (a.launched ?? 0));
  const found =
    newest.find((app) => is(app, (a, b) => a === b)) ??
    newest.find((app) => is(app, (a, b) => fold(a) === fold(b)));
  if (found !== undefined) {
    return { pid: found.pid };
  }
  // The applications a person opens come first: the helpers of the system are many, and a list
  // that is cut after them names nothing that can be joined.
  const person = [...running].sort(
    (a, b) => Number(true === b.regular) - Number(true === a.regular),
  );
  const names = [...new Set(person.map((app) => app.name).filter((name) => name.length > 0))];
  const near = names.filter((name) => fold(name).includes(fold(wanted)));
  const hint =
    near.length > 0
      ? `Did you mean: ${near.join(', ')}?`
      : `These are open: ${names.slice(0, NAMES_GIVEN).join(', ')}.`;
  return { error: `No application named ${wanted} is open. ${hint}` };
}

/** The file of the person at the machine: limits that no flag of the command can lift. */
export const OWNER_SETTINGS_FILE = 'computer-use.json';
/** The file that is there after Stop in the window: no application is joined while it is. */
export const STOPPED_FILE = 'computer-use.stopped';

function ownerSettings(text: string | undefined): { backgroundOnly: boolean; hud: boolean } {
  let parsed: unknown;
  try {
    parsed = text === undefined ? {} : JSON.parse(text);
  } catch {
    parsed = {};
  }
  const record: Record<string, unknown> =
    'object' === typeof parsed && null !== parsed ? (parsed as Record<string, unknown>) : {};
  return { backgroundOnly: true === record['backgroundOnly'], hud: true === record['hud'] };
}

/**
 * The plan with the limits of the person at the machine. An agent starts the command, so an
 * agent picks its flags. These limits are in a file of the person's own and a flag cannot lift
 * them: `backgroundOnly` forbids the real pointer, and `hud` keeps the window and the pointer of
 * the realm on the screen. After Stop in the window, no application is joined until the person
 * removes the file that Stop wrote.
 *
 * ponytail: a file in the home folder. A program with a shell can change a file, so this states
 * what the person wants and makes a change to it a deliberate act. It is not a wall.
 */
export function withOwnerLimits(
  plan: AttachPlan,
  settingsText: string | undefined,
  stoppedAt: string | undefined,
  stoppedPath: string,
): AttachPlan | { error: string } {
  if (stoppedAt !== undefined) {
    return {
      error: `The person at this machine stopped Reticle in its window (${stoppedAt.trim()}). Reticle joins no application until they remove the file ${stoppedPath}. Do not remove it for them: tell them what you wanted to do.`,
    };
  }
  const limits = ownerSettings(settingsText);
  return {
    ...plan,
    foreground: plan.foreground && !limits.backgroundOnly,
    hud: plan.hud || limits.hud,
  };
}
