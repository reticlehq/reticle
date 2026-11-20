/**
 * What `reticle-computer-use` needs to join a bridge: which application, which bridge, the token
 * of that bridge, and the folders to watch. Pure, so a test gives it arguments and files.
 */
import { join } from 'node:path';

import { RETICLE_DEFAULT_PORT, bridgeWsUrl } from '@reticlehq/core';

const Flag = {
  APP: '--app',
  PORT: '--port',
  WATCH: '--watch',
  PROJECT: '--project',
  ELECTRON_SWITCH: '--electron-switch',
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
   * `--project` names. Absent: no folder was named. The runs and flows of the session then go to
   * a folder for sessions with no project, and they do not reach the dashboard.
   */
  projectId?: string;
  /**
   * Turn on the accessibility switch of an Electron application, and turn it off at the end.
   * With the switch off, an Electron application shows its elements and does nothing for a press.
   * The switch costs that application some speed, so the person asks for it.
   */
  electronSwitch: boolean;
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
    return { error: `Name the application: ${Flag.APP} <name>.` };
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
    electronSwitch: argv.includes(Flag.ELECTRON_SWITCH),
  };
}

/** The file that every Electron application has in its bundle. */
const ELECTRON_MARK = 'Contents/Frameworks/Electron Framework.framework';
const BUNDLE = /^(.*?\.app)\//;

/**
 * What to say when an Electron application is joined with its switch off. `program` is the path
 * of the program of the process. Absent answer: the application is not Electron, or the switch
 * is asked for.
 */
export function electronWarning(
  program: string,
  plan: Pick<AttachPlan, 'app' | 'electronSwitch'>,
  exists: (path: string) => boolean,
): string | undefined {
  const bundle = BUNDLE.exec(program)?.[1];
  if (plan.electronSwitch || bundle === undefined || !exists(join(bundle, ELECTRON_MARK))) {
    return undefined;
  }
  return `${plan.app} is an Electron application. It shows its elements, and it does NOTHING for a press until its accessibility switch is on. Run again with ${Flag.ELECTRON_SWITCH}: the switch is then set, and it is set back when you stop. It costs ${plan.app} some speed.`;
}
