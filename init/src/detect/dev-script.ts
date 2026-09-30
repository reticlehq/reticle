/**
 * Which command starts this project, and should we start it ourselves?
 *
 * `init` finishes by telling the human to start or restart their dev server, in a closing
 * paragraph, in a terminal that is about to be cleared by the client restart it also asks for.
 * That is the second unmarked hand-off in the install, after the capabilities file, and it lands
 * on the same surface: prose nobody re-reads.
 *
 * Every fact needed to remove it is already in the project. `package.json` names the script; the
 * framework tells us the conventional port; a probe tells us whether something already answers
 * there. Nothing here needs a human.
 *
 * Kept as a PURE decision, separate from spawning, because the interesting part is the judgement —
 * which script, and whether to touch anything at all — and that is what wants testing. Spawning a
 * process is not.
 */

/** Script names a JS project uses to run itself, in the order we would pick them. */
export const DEV_SCRIPT_NAMES = ['dev', 'start', 'serve'] as const;
const CANDIDATES = DEV_SCRIPT_NAMES;

export const DevScriptChoice = {
  /** Something already answers on the port. Use it; never replace a server the user is running. */
  ALREADY_SERVING: 'already-serving',
  /** We know the command and nothing is listening. Start it. */
  START: 'start',
  /** No script we recognise. Say so rather than guess a command. */
  NO_SCRIPT: 'no-script',
} as const;
export type DevScriptChoice = (typeof DevScriptChoice)[keyof typeof DevScriptChoice];

interface DevScriptPlan {
  choice: DevScriptChoice;
  /** The npm script name, when there is one. */
  script?: string;
  /** What a human would type, for the line we print. */
  command?: string;
}

/**
 * Pick the script and decide whether to run it.
 *
 * `serving` is the probe result, passed in rather than measured here so the decision stays pure.
 * When something is already answering we do not care which script exists: the rule is never to
 * start a second server, because the one that is running may be the user's, with their state in it.
 *
 * `packageManagerCommand` is `Detection.packageManagerCommand` (see `preflight.ts`, #1149) — the
 * prefix that actually invokes the package manager on this machine, which is what gets printed AND,
 * later, spawned by `startDevServer`.
 */
export function planDevScript(
  scripts: Readonly<Record<string, string>>,
  packageManagerCommand: string,
  serving: boolean,
): DevScriptPlan {
  if (serving) return { choice: DevScriptChoice.ALREADY_SERVING };
  const name = CANDIDATES.find((c) => 'string' === typeof scripts[c] && scripts[c] !== '');
  if (name === undefined) return { choice: DevScriptChoice.NO_SCRIPT };
  return {
    choice: DevScriptChoice.START,
    script: name,
    command: runScript(packageManagerCommand, name),
  };
}

/**
 * `npm` needs `run`; the others take the script name directly. Getting this wrong prints a command
 * that fails, which is worse than printing nothing. `npm` is never corepack-prefixed (it ships with
 * node), so this comparison still identifies it correctly.
 */
function runScript(packageManagerCommand: string, script: string): string {
  return 'npm' === packageManagerCommand
    ? `npm run ${script}`
    : `${packageManagerCommand} ${script}`;
}

/** How a desktop shell is launched: through one of its scripts, or its CLI when none names it. */
export type DesktopLaunch =
  { readonly script: string; readonly args: string } | { readonly command: string };

const TAURI_CLI_PACKAGE = '@tauri-apps/cli';
/** The official template's script: `"tauri": "tauri"`, so `<pm> tauri dev` is its dev command. */
const TAURI_SCRIPT = 'tauri';
const TAURI_DEV_ARG = 'dev';
const TAURI_DIRECT = 'npx tauri dev';
const FORGE_CLI_PACKAGE = '@electron-forge/cli';
const FORGE_START = /\belectron-forge\s+start\b/;
const FORGE_DIRECT = 'npx electron-forge start';

function manifestRecord(pkg: unknown, key: string): Record<string, unknown> {
  const value: unknown = 'object' === typeof pkg && null !== pkg ? Reflect.get(pkg, key) : {};
  return 'object' === typeof value && null !== value ? (value as Record<string, unknown>) : {};
}

/**
 * The desktop shell's own launcher, when the manifest names one; undefined for anything else.
 *
 * A desktop project's `dev` script is its RENDERER's dev server: on the official Tauri template it
 * is plain `vite`, so init ran it, no window ever opened, and the run waited out its whole budget
 * for a session only the window could create. The shell's CLI is what opens the window.
 *
 * Exported because the daemon names a dev command too (its no-session next action), and two
 * readers of one manifest have to give one answer.
 */
export function desktopLaunch(pkg: unknown): DesktopLaunch | undefined {
  const scripts = manifestRecord(pkg, 'scripts');
  const deps = {
    ...manifestRecord(pkg, 'dependencies'),
    ...manifestRecord(pkg, 'devDependencies'),
  };
  const tauriScript = scripts[TAURI_SCRIPT];
  if ('string' === typeof tauriScript && 0 < tauriScript.trim().length) {
    return { script: TAURI_SCRIPT, args: TAURI_DEV_ARG };
  }
  if (undefined !== deps[TAURI_CLI_PACKAGE]) return { command: TAURI_DIRECT };
  const forge = Object.entries(scripts).find(
    ([, body]) => 'string' === typeof body && FORGE_START.test(body),
  );
  if (undefined !== forge) return { script: forge[0], args: '' };
  if (undefined !== deps[FORGE_CLI_PACKAGE]) return { command: FORGE_DIRECT };
  return undefined;
}

/**
 * The command to print for this project, straight from its `package.json`.
 *
 * Lives here rather than in `run.ts` because it is the same judgement as `planDevScript` with the
 * parsing attached, and `run.ts` is at its cohesion limit. Returns undefined for anything it cannot
 * read: this phrasing decides nothing, so it must never be able to break an install.
 */
export function devCommandFrom(pkg: unknown, packageManagerCommand: string): string | undefined {
  try {
    // Takes the PARSED manifest. It used to take the raw string and parse it a fourth time — the
    // caller now reads the file once, through a guard, so there is one place a malformed manifest
    // can be noticed and it is not this one.
    const desktop = desktopLaunch(pkg);
    if (undefined !== desktop) {
      if ('command' in desktop) return desktop.command;
      const run = runScript(packageManagerCommand, desktop.script);
      return 0 < desktop.args.length ? `${run} ${desktop.args}` : run;
    }
    const scripts =
      'object' === typeof pkg && null !== pkg
        ? ((pkg as { scripts?: Record<string, string> }).scripts ?? {})
        : {};
    return planDevScript(scripts, packageManagerCommand, false).command;
  } catch {
    return undefined;
  }
}

/** The dev script's own command line (`react-router dev`, `vite`), or undefined when there is none. */
export function devScriptBody(pkg: unknown): string | undefined {
  const scripts: unknown =
    'object' === typeof pkg && null !== pkg ? (pkg as { scripts?: unknown }).scripts : undefined;
  if ('object' !== typeof scripts || null === scripts) return undefined;
  const table = scripts as Record<string, unknown>;
  const name = CANDIDATES.find((c) => 'string' === typeof table[c] && table[c] !== '');
  const body = name === undefined ? undefined : table[name];
  return 'string' === typeof body ? body : undefined;
}
