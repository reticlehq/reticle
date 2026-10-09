/**
 * Pure CLI argument parsing — the command/flag grammar, the CliResult union, and parseCliArgs.
 * The parser stays pure and unit-testable; `cli.ts` owns the side-effecting handlers and dispatch,
 * and re-exports this surface.
 */
import { TutorialAudience } from './tutorial.js';
import { parseFeedbackArgs, type ParsedFeedback } from './cli-parse-feedback.js';
import { parseVerifySuffix } from './cli-parse-verify.js';
import {
  HEADED_FLAG,
  PORT_FLAG,
  VERIFY_COMMAND,
  missingOperand,
  missingValue,
  notANumber,
  retiredFlag,
  unknownArgument,
  type ParseError,
  CLOUD_COMMANDS,
} from './cli-parse-grammar.js';

// Re-exported because the daemon's own argv builder reaches for these through this module, which is
// where the grammar has always lived as far as every caller is concerned.
export { HEADED_FLAG, PORT_FLAG };
import { FORCE_FLAG } from './cli-kill.js';

// Re-exported so every existing importer of these flags is unaffected by the file split.
export {
  AGENT_FLAG,
  BUG_FLAG,
  FEEDBACK_KINDS,
  KIND_FLAG,
  RATING_FLAG,
} from './cli-parse-feedback.js';

// The help text lives on its own page; re-exported so every importer of it is unaffected.
import { CLI_USAGE } from './cli-usage.js';
export { CLI_USAGE };

const INIT_COMMAND = 'init';
const SERVE_COMMAND = 'serve';
const STOP_COMMAND = 'stop';
const KILL_COMMAND = 'kill';
const RESTART_COMMAND = 'restart';
const STATUS_COMMAND = 'status';
const OPEN_COMMAND = 'open';
const DRIVE_COMMAND = 'drive';
const AFFECTED_COMMAND = 'affected';
const HUNT_COMMAND = 'hunt';
const CAPSULES_COMMAND = 'capsules';
const GATE_COMMAND = 'gate';
/** Hook mode: prose a human can read, and silence when there was simply nothing to check. */
const HOOK_FLAG = '--hook';
const ACCEPT_COVERAGE_FLAG = '--accept-coverage';
/** `reticle report [--session <id>] [--hook]` — what the latest session claimed, and what held. */
const REPORT_COMMAND = 'report';
const SESSION_FLAG = '--session';
const WATCH_COMMAND = 'watch';
const UPDATE_COMMAND = 'update';
const ROLLBACK_COMMAND = 'rollback';
const MCP_COMMAND = 'mcp';
const LICENSE_COMMAND = 'license';
const VERSION_COMMAND = 'version';
const TELEMETRY_COMMAND = 'telemetry';
const FEEDBACK_COMMAND = 'feedback';
const IDENTIFY_COMMAND = 'identify';
const DOCTOR_COMMAND = 'doctor';
const SETUP_COMMAND = 'setup';
const TUTORIAL_COMMAND = 'tutorial';
const COMPANY_FLAG = '--company';
const EMAIL_FLAG = '--email';
const CONTEXT_FLAG = '--context';
const FORGET_FLAG = '--forget';
/** The `reticle telemetry` sub-actions. Bare `reticle telemetry` means `status`. */
export const TelemetryAction = {
  STATUS: 'status',
  ENABLE: 'enable',
  DISABLE: 'disable',
} as const;
export type TelemetryAction = (typeof TelemetryAction)[keyof typeof TelemetryAction];
export const DAEMON_INNER_COMMAND = '_daemon';

/**
 * Every subcommand a person can type, as one closed vocabulary. Telemetry reports which one ran, and
 * this is what keeps that property low-cardinality and non-identifying: an argument we do not
 * recognize reports as `unknown` rather than being echoed, so a typo — which may be a path, a URL, or
 * a flow name — can never reach the wire just because someone misspelled `status`.
 *
 * Lives here rather than in the telemetry module because this is where the command names are already
 * defined; a second list somewhere else would drift the first time a command is added.
 */
export const UNKNOWN_COMMAND = 'unknown';
const HELP_COMMAND = 'help';
/** Every command the typed parser below routes. The parser refuses any word not in this list. */
export const LOCAL_COMMANDS: readonly string[] = [
  INIT_COMMAND,
  SERVE_COMMAND,
  STOP_COMMAND,
  KILL_COMMAND,
  RESTART_COMMAND,
  STATUS_COMMAND,
  OPEN_COMMAND,
  DRIVE_COMMAND,
  VERIFY_COMMAND,
  AFFECTED_COMMAND,
  HUNT_COMMAND,
  CAPSULES_COMMAND,
  GATE_COMMAND,
  REPORT_COMMAND,
  WATCH_COMMAND,
  UPDATE_COMMAND,
  ROLLBACK_COMMAND,
  MCP_COMMAND,
  LICENSE_COMMAND,
  VERSION_COMMAND,
  TELEMETRY_COMMAND,
  FEEDBACK_COMMAND,
  IDENTIFY_COMMAND,
  DAEMON_INNER_COMMAND,
  DOCTOR_COMMAND,
  SETUP_COMMAND,
  TUTORIAL_COMMAND,
];
const LOCAL_COMMAND_SET: ReadonlySet<string> = new Set(LOCAL_COMMANDS);
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  ...LOCAL_COMMANDS,
  ...CLOUD_COMMANDS,
  HELP_COMMAND,
]);
/** The conventional flag spellings of two commands, reported as the command they ask for. */
const COMMAND_FLAG_ALIASES: ReadonlyMap<string, string> = new Map([
  ['--version', VERSION_COMMAND],
  ['-v', VERSION_COMMAND],
  ['--help', HELP_COMMAND],
  ['-h', HELP_COMMAND],
]);

/**
 * A non-negative integer flag, or 0.
 *
 * 0 means NOT MEASURED here, and that is safe only because these are elapsed times the shell always
 * passes — an absent one is a caller that is not our installer, and reporting zero for it is more
 * honest than inventing a duration.
 */
function numberFlag(args: readonly string[], name: string): number {
  const at = args.indexOf(name);
  if (at < 0) return 0;
  const raw = Number(args[at + 1]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/** The subcommand name if we recognize it, else `unknown`. Bare `reticle` reports `help`. */
export function knownCommand(arg: string | undefined): string {
  if (arg === undefined || '' === arg) return HELP_COMMAND;
  return KNOWN_COMMANDS.has(arg) ? arg : (COMMAND_FLAG_ALIASES.get(arg) ?? UNKNOWN_COMMAND);
}

/**
 * Force a hidden browser. The default is now HEADED: a run nobody can see is a run nobody trusts,
 * and every "did it actually do anything?" question cost a round-trip. CI passes this (or just sets
 * CI, which flips the default) because there is no display there to be headed on.
 */
export const HEADLESS_FLAG = '--headless';
export const DRIVE_FLAG = '--drive';
const QUIET_FLAG = '--quiet';
const DRY_RUN_FLAG = '--dry-run';
const YES_FLAG = '--yes';
const NO_MCP_FLAG = '--no-mcp';
const APP_FLAG = '--app';
/**
 * What only the caller can know, and what it may switch off.
 *
 * `--flow`, `--env` and `--app` are an AGENT's answers: which journey proves the thing the user
 * cares about, what the app needs to reach a usable state, and which app in a monorepo. None is
 * inferable from the repository alone, and a run without them either guesses or stops.
 *
 * `--files-only` is the escape hatch for a caller that wants what init used to do and nothing more.
 */
const FLOW_FLAG = '--flow';
/** Where the drive went, named in full because the reader passing one of these is following us. */
const FIRST_RUN_MOVED =
  'onboarding wires the project, the FIRST RUN proves a flow. Drive one with reticle_verify { action: "explore", persona: "<who does what>" }, or npx @reticlehq/server verify <url> --explore --persona "<who does what>"';
const ENV_FLAG = '--env';
const FILES_ONLY_FLAG = '--files-only';
/**
 * Write `captureNetworkBodies: true` into the app's config. OFF unless asked (#705).
 *
 * Body capture is what makes a 2xx write's OUTCOME readable rather than just its transport, so it
 * is worth having — but a body is the one part of a request that routinely carries personal data,
 * and `init` runs unattended. Whoever passes this has decided; nothing decides it for them.
 */
const CAPTURE_BODIES_FLAG = '--capture-bodies';
/** `--hooks`: also install the print-only Claude Code Stop hook (`reticle report --hook`). */
const HOOKS_FLAG = '--hooks';
/**
 * The rest of the runtime surface.
 *
 * `--json` is not a convenience: SKILL.md tells an agent to read the result and act on `agentTodo`,
 * and reading one object is one turn where interpreting a report is several. The three opt-outs are
 * what a machine without a browser, or a caller already running their app, actually needs.
 */
const JSON_FLAG = '--json';
const NO_DRIVE_FLAG = '--no-drive';
const NO_OPEN_FLAG = '--no-open';
const NO_AGENTS_FLAG = '--no-agents';
/**
 * Restart the calling client so IT gets the tools.
 *
 * The flag was accepted by the prototype and not by `init`, so passing it printed the whole usage
 * text. `init` decides what a restart should do — including refusing an id with no transcript, which
 * is the case that looks exactly like success — and prints it; performing the restart is the
 * caller's, because opening a terminal is not something a one-shot command should do behind a flag.
 */
const RELAUNCH_FLAG = '--relaunch';
const URL_FLAG = '--url';
const TIMEOUT_FLAG_INIT = '--timeout';
const DRIVE_MODEL_FLAG = '--drive-model';
/**
 * The key, written to .env by the command rather than by hand.
 *
 * The instructions used to ask an agent for three steps: append to .env, check .gitignore, confirm.
 * All three are deterministic, and the second is the one that costs something when skipped, because
 * a key committed to git is leaked and stays leaked after the file is removed.
 */
const LICENSE_FLAG = '--license';
const NO_INSTALL_FLAG = '--no-install';
export const HTTP_FLAG = '--http';
export const HTTP_PORT_FLAG = '--http-port';
export const HTTP_TOKEN_FLAG = '--http-token';
/**
 * A predicate for a flow-free, one-shot verdict against the daemon that is already running.
 *
 * The dead end this removes: a client that never loaded the `reticle_*` tools had no path to a
 * verdict at all. `verify` refused because the daemon owned the port — the normal state after a
 * working install — the other verdict paths need saved flows a first-install project does not have,
 * and stopping the daemon cuts the agent's own MCP link.
 */

export type CliResult =
  | {
      kind: 'init';
      port: number | undefined;
      mcp: boolean;
      dryRun: boolean;
      install: boolean;
      app: string | undefined;
      env: string[];
      filesOnly: boolean;
      captureBodies: boolean;
      hooks: boolean;
      json: boolean;
      relaunch: boolean;
      open: boolean;
      agents: boolean;
      url: string | undefined;
      timeoutSeconds: number | undefined;
      licenseKey: string | undefined;
    }
  | {
      kind: 'serve';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'stop'; port: number; quiet: boolean }
  | { kind: 'kill'; port: number; force: boolean }
  | { kind: 'restart'; port: number; force: boolean }
  | { kind: 'status'; port: number; json: boolean }
  | { kind: 'license' }
  | { kind: 'telemetry'; action: TelemetryAction }
  | Extract<ParsedFeedback, { kind: 'feedback' }>
  | { kind: 'identify'; context?: string; company?: string; email?: string; forget: boolean }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'doctor'; port: number }
  | { kind: 'setup-mcp' }
  | { kind: 'setup-install'; runtimeSecs: number; installSecs: number; mcp: boolean }
  | { kind: 'tutorial'; audience: TutorialAudience; run: boolean; port: number; headless: boolean }
  | { kind: 'open'; port: number; url?: string }
  | {
      kind: '_daemon';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'drive'; port: number; driveUrl: string; headless: boolean }
  | {
      kind: 'verify';
      url: string;
      headless: boolean;
      port: number;
      timeoutMs?: number;
      storageState?: string;
      sessionId?: string;
      expect?: unknown;
      expectFile?: string;
      explore?: boolean;
      persona?: string;
      select?: string[];
      resultsJson?: string;
    }
  | { kind: 'affected'; files: string[]; since?: string }
  | { kind: 'hunt'; dir: string }
  | { kind: 'capsules' }
  | { kind: 'gate'; files: string[]; since?: string; hook?: boolean; acceptCoverage?: boolean }
  | { kind: 'report'; session?: string; hook: boolean }
  | { kind: 'watch'; url?: string }
  | { kind: 'update' }
  | { kind: 'rollback' }
  | {
      kind: 'mcp';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'error'; message: string };

type ServeFlags =
  | {
      kind: 'ok';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'error'; message: string };

/**
 * A usage error names the thing that was wrong.
 *
 * These used to return CLI_USAGE as the MESSAGE, so every mistake — a typo'd flag, a flag missing
 * its value, an unknown command — produced the same 600-character help block, JSON-escaped onto one
 * stderr line by `log()`, with no mention of what the parser actually rejected. The install gate
 * reported it verbatim as "init crashed: <the entire help text>", which is unreadable in a report
 * and undiagnosable from a CI log; a human who typed one wrong flag got the same wall.
 *
 * The help text is still shown — cli.ts renders it as readable text underneath. It is just not the
 * message any more.
 */
const requiresHttp = (flag: string): ParseError => ({
  kind: 'error',
  message: `${flag} requires ${HTTP_FLAG} — it configures the verify endpoint ${HTTP_FLAG} starts`,
});
const unknownCommand = (command: string): ParseError => ({
  kind: 'error',
  message: `unknown command '${command}'`,
});

function parseServeFlags(
  args: string[],
  defaultPort: number,
  defaultHeadless: boolean,
): ServeFlags {
  let port = defaultPort;
  let driveUrl: string | undefined;
  let headless = defaultHeadless;
  let http = false;
  let httpPort: number | undefined;
  let httpToken: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // `i < args.length` already guarantees this, but the index signature does not say so and the
    // unknown-argument error needs a real string to name.
    if (arg === undefined) break;
    if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(PORT_FLAG, n);
      port = parsed;
    } else if (arg === DRIVE_FLAG) {
      i++;
      driveUrl = args[i];
      if (driveUrl === undefined) return missingValue(DRIVE_FLAG);
    } else if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg === HEADLESS_FLAG) {
      headless = true;
    } else if (arg === HTTP_FLAG) {
      http = true;
    } else if (arg === HTTP_PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(HTTP_PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(HTTP_PORT_FLAG, n);
      httpPort = parsed;
    } else if (arg === HTTP_TOKEN_FLAG) {
      i++;
      httpToken = args[i];
      if (httpToken === undefined) return missingValue(HTTP_TOKEN_FLAG);
    } else {
      return unknownArgument(arg);
    }
    i++;
  }
  // Without `--http` these flags configure an endpoint nothing starts, and they were accepted and
  // silently ignored — worse than being rejected, because the whole reason to pass them is to be
  // honoured (#687).
  if (!http && httpPort !== undefined) return requiresHttp(HTTP_PORT_FLAG);
  if (!http && httpToken !== undefined) return requiresHttp(HTTP_TOKEN_FLAG);
  return {
    kind: 'ok',
    port,
    headless,
    http,
    ...(driveUrl !== undefined ? { driveUrl } : {}),
    ...(httpPort !== undefined ? { httpPort } : {}),
    ...(httpToken !== undefined ? { httpToken } : {}),
  };
}

function parsePortFlag(args: string[], defaultPort: number): number {
  const idx = args.indexOf(PORT_FLAG);
  if (-1 === idx) return defaultPort;
  const n = args[idx + 1];
  if (n === undefined) return defaultPort;
  const parsed = parseInt(n, 10);
  return isNaN(parsed) ? defaultPort : parsed;
}

type DriveSuffix =
  | { kind: 'ok'; port: number; driveUrl: string; headless: boolean }
  | { kind: 'error'; message: string };

function parseDriveSuffix(args: string[], port: number, defaultHeadless: boolean): DriveSuffix {
  let headless = defaultHeadless;
  let driveUrl: string | undefined;
  for (const arg of args) {
    if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg === HEADLESS_FLAG) {
      headless = true;
    } else if (arg.startsWith('--')) {
      return unknownArgument(arg);
    } else if (driveUrl === undefined) {
      driveUrl = arg;
    } else {
      return unknownArgument(arg);
    }
  }
  if (driveUrl === undefined) return missingOperand(DRIVE_COMMAND, 'a url');
  return { kind: 'ok', port, driveUrl, headless };
}

type InitFlags =
  | {
      kind: 'ok';
      port: number | undefined;
      mcp: boolean;
      dryRun: boolean;
      install: boolean;
      app: string | undefined;
      env: string[];
      filesOnly: boolean;
      captureBodies: boolean;
      hooks: boolean;
      json: boolean;
      relaunch: boolean;
      open: boolean;
      agents: boolean;
      url: string | undefined;
      timeoutSeconds: number | undefined;
      licenseKey: string | undefined;
    }
  | { kind: 'error'; message: string };

function parseInitFlags(args: string[]): InitFlags {
  let port: number | undefined;
  let mcp = true;
  let dryRun = false;
  let install = true;
  let app: string | undefined;
  // Repeatable: one variable per flag, so a value containing spaces or `=` needs no quoting rules.
  const env: string[] = [];
  let filesOnly = false;
  let captureBodies = false;
  let hooks = false;
  let json = false;
  let open = true;
  let relaunch = false;
  let agents = true;
  let url: string | undefined;
  let timeoutSeconds: number | undefined;
  let licenseKey: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // `i < args.length` already guarantees this, but the index signature does not say so and the
    // unknown-argument error needs a real string to name.
    if (arg === undefined) break;
    if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(PORT_FLAG, n);
      port = parsed;
    } else if (arg === APP_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(APP_FLAG);
      app = value;
    } else if (arg === FLOW_FLAG || arg === NO_DRIVE_FLAG || arg === DRIVE_MODEL_FLAG) {
      return retiredFlag(arg, FIRST_RUN_MOVED);
    } else if (arg === ENV_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(ENV_FLAG);
      env.push(value);
    } else if (arg === FILES_ONLY_FLAG) {
      filesOnly = true;
    } else if (arg === CAPTURE_BODIES_FLAG) {
      captureBodies = true;
    } else if (arg === HOOKS_FLAG) {
      hooks = true;
    } else if (arg === JSON_FLAG) {
      json = true;
    } else if (arg === NO_OPEN_FLAG) {
      open = false;
    } else if (arg === RELAUNCH_FLAG) {
      relaunch = true;
    } else if (arg === NO_AGENTS_FLAG) {
      agents = false;
    } else if (arg === URL_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(URL_FLAG);
      url = value;
    } else if (arg === LICENSE_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(LICENSE_FLAG);
      licenseKey = value;
    } else if (arg === TIMEOUT_FLAG_INIT) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(TIMEOUT_FLAG_INIT);
      const seconds = parseInt(value, 10);
      if (isNaN(seconds)) return notANumber(TIMEOUT_FLAG_INIT, value);
      timeoutSeconds = seconds;
    } else if (arg === NO_MCP_FLAG) {
      mcp = false;
    } else if (arg === NO_INSTALL_FLAG) {
      install = false;
    } else if (arg === DRY_RUN_FLAG) {
      dryRun = true;
    } else if (arg === YES_FLAG) {
      // Accepted for scripting/CI; init has no interactive prompts today.
    } else {
      return unknownArgument(arg);
    }
    i++;
  }
  return {
    kind: 'ok',
    port,
    mcp,
    dryRun,
    install,
    app,
    env,
    filesOnly,
    captureBodies,
    hooks,
    json,
    open,
    relaunch,
    agents,
    url,
    timeoutSeconds,
    licenseKey,
  };
}

/** Pure CLI arg parser — exported for unit tests. argv = process.argv.slice(2). */
const SINCE_FLAG = '--since';

/** Parse `[--since <ref>] [file...]` shared by `affected` and `gate`. */
/**
 * What `reticle gate` / `reticle affected` mean with NOTHING after them: the working tree.
 *
 * They used to mean a usage error — while the rule `reticle init` writes into the agent's own
 * instruction file says, in as many words, "run `reticle gate`". An instruction the tool rejects is
 * worse than no instruction: the agent spends a turn on it and concludes Reticle is broken.
 *
 * HEAD is the ref that answers the question being asked. Explicit files or an explicit --since still
 * win; this only fills the empty case.
 */
const WORKING_TREE_REF = 'HEAD';

function implicitSince(files: readonly string[]): string | undefined {
  return 0 === files.length ? WORKING_TREE_REF : undefined;
}

function parseTargetArgs(rest: string[]): { files: string[]; since?: string } {
  const files: string[] = [];
  let since: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === SINCE_FLAG) {
      since = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg !== undefined && !arg.startsWith('-')) files.push(arg);
  }
  return since === undefined ? { files } : { files, since };
}

/**
 * Whether this command talks to a daemon on the resolved port, and so must not run when
 * the workspace port conflict (cli-port) has said the port is a guess. `init` carries a port but resolves the
 * workspace itself, and a tutorial only dials one when asked to run.
 */
export function dialsTheDaemon(parsed: CliResult): boolean {
  if ('init' === parsed.kind) return false;
  if ('tutorial' === parsed.kind) return parsed.run;
  return 'port' in parsed;
}

/**
 * @param defaultHeadless Whether a browser Reticle launches should be hidden when no flag says
 *   otherwise. Injected rather than read from the environment here, because this module is pure —
 *   `cli.ts` decides it from `CI`. The product default is FALSE: showing the run is what makes it
 *   trustworthy, and asking people to opt into seeing their own app was backwards.
 */
export function parseCliArgs(
  argv: string[],
  defaultPort: number,
  defaultHeadless = false,
): CliResult {
  // Bare `reticle` is `serve`.
  if (0 === argv.length)
    return { kind: 'serve', port: defaultPort, headless: defaultHeadless, http: false };

  const [cmd, ...rest] = argv;
  // Guaranteed by the bare-argv check above; restated so the unknown-command error can name it.
  if (cmd === undefined) return { kind: 'error', message: CLI_USAGE };

  // `version` (or the conventional -v/--version flags) prints the running version — the diagnostic the
  // troubleshooting docs lean on to confirm which npx-resolved build is actually executing.
  if (cmd === VERSION_COMMAND || '--version' === cmd || '-v' === cmd) return { kind: 'version' };

  // `help` (and the conventional -h/--help) print usage to stdout and exit 0 — the universal first move
  // for a new user, which otherwise fell through to a JSON error with exit 1.
  //
  // Recognised ANYWHERE in the argv, not only in first position. `reticle init --help` is the shape
  // people actually type — it was the very first command in a field install transcript — and it hit
  // the subcommand's own flag parser, which does not know the flag and answered
  // `reticle_usage_error: unknown argument '--help'` on stderr with exit 1. The usage text was
  // printed underneath it, so the request was in fact answered; it was simply answered as a failure,
  // which is the wrong first impression to give somebody who has just asked a tool what it does.
  if ('help' === cmd || argv.some((arg) => '--help' === arg || '-h' === arg)) {
    return { kind: 'help' };
  }

  // The list is the gate, so a command cannot be routed without also being named in telemetry.
  if (!LOCAL_COMMAND_SET.has(cmd)) return unknownCommand(cmd);
  switch (cmd) {
    case INIT_COMMAND: {
      const r = parseInitFlags(rest);
      if ('error' === r.kind) return r;
      return {
        kind: 'init',
        port: r.port,
        mcp: r.mcp,
        dryRun: r.dryRun,
        install: r.install,
        app: r.app,
        env: r.env,
        filesOnly: r.filesOnly,
        captureBodies: r.captureBodies,
        hooks: r.hooks,
        json: r.json,
        open: r.open,
        relaunch: r.relaunch,
        agents: r.agents,
        url: r.url,
        timeoutSeconds: r.timeoutSeconds,
        licenseKey: r.licenseKey,
      };
    }
    case SERVE_COMMAND: {
      const r = parseServeFlags(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return {
        kind: 'serve',
        port: r.port,
        headless: r.headless,
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
      };
    }
    case STOP_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      const quiet = rest.includes(QUIET_FLAG);
      return { kind: 'stop', port, quiet };
    }
    case KILL_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'kill', port, force: rest.includes(FORCE_FLAG) };
    }
    case RESTART_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'restart', port, force: rest.includes(FORCE_FLAG) };
    }
    case STATUS_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      // The block is the default and the JSON is the opt-in, which is the way round `tutorial`
      // already settled on: a person typing this should not have to ask for prose, and a caller
      // parsing it knows to ask for the object.
      return { kind: 'status', port, json: rest.includes(JSON_FLAG) };
    }
    case TUTORIAL_COMMAND: {
      // `--agent` is the opt-in, because a person typing this is the common case and should not have
      // to ask for prose. An agent knows to pass the flag; a human would not know to avoid it.
      const audience = argv.includes('--agent') ? TutorialAudience.AGENT : TutorialAudience.HUMAN;
      // `--run` drives the demo instead of describing it. Opt-in rather than the default: the tour
      // starts a daemon and opens a browser, and a command that did that to somebody who typed it
      // expecting a page of text would be a surprise in the one place surprises are least welcome.
      return {
        kind: 'tutorial',
        audience,
        run: argv.includes('--run'),
        port: parsePortFlag(rest, defaultPort),
        headless: !argv.includes('--headed'),
      };
    }
    case DOCTOR_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'doctor', port };
    }
    /*
     * `setup mcp` — register the MCP server with the coding agents on this machine.
     *
     * Separate from `init` because it answers a different question. `init` wires ONE PROJECT: the
     * plugin, the connect snippet, the config. This registers the server for the USER, across every
     * agent they have, and is what the one-line installer runs when there is no project yet.
     *
     * There is NO `--yes`, and the absence is deliberate. Zero human input is the default, so
     * nothing is ever asked — and a flag that reads as consent while gating nothing is worse than
     * no flag: it tells a reader a confirmation exists. What this writes is stated before it runs
     * and printed after, which is the honest version of the same reassurance.
     */
    case SETUP_COMMAND: {
      const what = rest[0];
      /*
       * `setup install` — the Node half of the one-line installer.
       *
       * The shell script does the three things that cannot be Node (is there a runtime, put the CLI
       * on the machine, hand over) and nothing else, because a .sh and a .ps1 holding the same logic
       * drift the first time somebody fixes a bug in one of them. The timings arrive as flags
       * because only the shell could measure them: they span the period before this binary existed.
       */
      if ('install' === what) {
        return {
          kind: 'setup-install',
          runtimeSecs: numberFlag(rest, '--runtime-secs'),
          installSecs: numberFlag(rest, '--install-secs'),
          mcp: !rest.includes('--no-mcp'),
        };
      }
      // Only `mcp` today. A bare `reticle setup` falls to help rather than guessing, because the
      // next subcommand here will not be a synonym for this one.
      if (what !== 'mcp') return { kind: 'help' };
      return { kind: 'setup-mcp' };
    }
    case LICENSE_COMMAND:
      return { kind: 'license' };
    case TELEMETRY_COMMAND: {
      const action = rest[0] ?? TelemetryAction.STATUS;
      if (
        action !== TelemetryAction.STATUS &&
        action !== TelemetryAction.ENABLE &&
        action !== TelemetryAction.DISABLE
      ) {
        return { kind: 'error', message: `unknown telemetry action: ${action}` };
      }
      return { kind: 'telemetry', action };
    }
    case IDENTIFY_COMMAND: {
      const flag = (name: string): string | undefined => {
        const at = rest.indexOf(name);
        return -1 === at ? undefined : rest[at + 1];
      };
      const context = flag(CONTEXT_FLAG);
      const company = flag(COMPANY_FLAG);
      const email = flag(EMAIL_FLAG);
      return {
        kind: 'identify',
        ...(context !== undefined ? { context } : {}),
        ...(company !== undefined ? { company } : {}),
        ...(email !== undefined ? { email } : {}),
        forget: rest.includes(FORGET_FLAG),
      };
    }
    case FEEDBACK_COMMAND:
      return parseFeedbackArgs(rest);
    case OPEN_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      // The first non-flag arg is the url (optional — omitting reuses a connected tab).
      const url = rest.find((a) => !a.startsWith('--') && a !== String(port));
      return url !== undefined ? { kind: 'open', port, url } : { kind: 'open', port };
    }
    case DRIVE_COMMAND: {
      const r = parseDriveSuffix(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return { kind: 'drive', port: r.port, driveUrl: r.driveUrl, headless: r.headless };
    }
    case DAEMON_INNER_COMMAND: {
      const r = parseServeFlags(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return {
        kind: '_daemon',
        port: r.port,
        headless: r.headless,
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
      };
    }
    case VERIFY_COMMAND: {
      const r = parseVerifySuffix(rest, defaultPort);
      if ('error' === r.kind) return r;
      return {
        kind: 'verify',
        url: r.url,
        headless: r.headless,
        port: r.port,
        ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
        ...(r.storageState !== undefined ? { storageState: r.storageState } : {}),
        ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
        ...(r.expect !== undefined ? { expect: r.expect } : {}),
        ...(r.expectFile !== undefined ? { expectFile: r.expectFile } : {}),
        ...(true === r.explore ? { explore: true } : {}),
        ...(r.persona !== undefined ? { persona: r.persona } : {}),
        ...(r.select !== undefined ? { select: r.select } : {}),
        ...(r.resultsJson !== undefined ? { resultsJson: r.resultsJson } : {}),
      };
    }
    case CAPSULES_COMMAND:
      return { kind: 'capsules' };
    case HUNT_COMMAND: {
      const dir = rest.find((a) => !a.startsWith('-'));
      return dir === undefined
        ? { kind: 'error', message: 'usage: reticle hunt <dir-of-crawl-reports>' }
        : { kind: 'hunt', dir };
    }
    case AFFECTED_COMMAND: {
      const t = parseTargetArgs(rest);
      const since = t.since ?? implicitSince(t.files);
      return { kind: 'affected', files: t.files, ...(since === undefined ? {} : { since }) };
    }
    case GATE_COMMAND: {
      // Flags are stripped before target parsing, which would reject them as unknown.
      const hook = rest.includes(HOOK_FLAG);
      const acceptCoverage = rest.includes(ACCEPT_COVERAGE_FLAG);
      const t = parseTargetArgs(rest.filter((a) => a !== HOOK_FLAG && a !== ACCEPT_COVERAGE_FLAG));
      const since = t.since ?? implicitSince(t.files);
      return {
        kind: 'gate',
        files: t.files,
        ...(since === undefined ? {} : { since }),
        ...(hook ? { hook: true } : {}),
        ...(acceptCoverage ? { acceptCoverage: true } : {}),
      };
    }
    case REPORT_COMMAND: {
      const at = rest.indexOf(SESSION_FLAG);
      const session = -1 === at ? undefined : rest[at + 1];
      return {
        kind: 'report',
        hook: rest.includes(HOOK_FLAG),
        ...(session === undefined ? {} : { session }),
      };
    }
    case WATCH_COMMAND: {
      // `reticle watch [url]` — on file save, report which saved flows must re-verify.
      const url = rest.find((arg) => !arg.startsWith('-'));
      return url === undefined ? { kind: 'watch' } : { kind: 'watch', url };
    }
    case UPDATE_COMMAND:
      return { kind: 'update' };
    case ROLLBACK_COMMAND:
      return { kind: 'rollback' };
    case MCP_COMMAND: {
      const r = parseServeFlags(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return {
        kind: 'mcp',
        port: r.port,
        headless: r.headless,
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
      };
    }
    default:
      // A bare `reticle` never lands here — it defaults to `serve` above — so `cmd` is always a real
      // word somebody typed, and naming it is strictly more useful than reprinting the whole help.
      return unknownCommand(cmd);
  }
}
