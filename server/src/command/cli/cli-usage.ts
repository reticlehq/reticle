/**
 * The `reticle` help text.
 *
 * `reticle --help` is short: the commands a person needs, one line each, in four groups. Every other
 * command is still there and still works; `reticle help all` lists it, and `reticle <command> --help`
 * carries the detail that used to sit in the one long page.
 *
 * The lines say `reticle <command>`, which is the bin this package installs. Copied into `npx` it is
 * not: `npx reticle` resolves the PACKAGE named `reticle`, which belongs to somebody else, and npx
 * will happily fetch and run it. So the npx spelling leads every page.
 */

export const HelpGroup = {
  START: 'Get started',
  CHECK: 'Check your app',
  MACHINE: 'Reticle on this machine',
  ACCOUNT: 'Account',
  /** Listed only by `reticle help all`. */
  MORE: 'More commands',
} as const;
export type HelpGroup = (typeof HelpGroup)[keyof typeof HelpGroup];

/** `reticle help all` and `reticle --help all`. */
export const HELP_ALL_TOPIC = 'all';

interface CommandDoc {
  readonly name: string;
  /** What follows `reticle` on the usage line. */
  readonly synopsis: string;
  /** One line, plain words. */
  readonly summary: string;
  readonly group: HelpGroup;
  /** Shown only by `reticle <name> --help`. */
  readonly detail?: string;
}

const INIT_DETAIL = `init wires the project, boots the app and proves a page connected. With a linked
project it then drives the first flow in your open tab and saves it; without one it names
the next step (your coding agent, or reticle connect).

  --app <dir>        which app in a monorepo, when several are found
  --env KEY=VALUE    what the app needs to reach a usable state (repeatable)
  --files-only       write the files and stop; do not boot the app
  --no-install       do not install packages
  --no-mcp           skip the MCP registration, the agent rule files and the /reticle command
  --hooks            also install the agent hooks
  --relaunch         print the command that restarts this agent conversation with the tools loaded
  --license <key>    write an enterprise key to .env and keep .env out of git
  --json             print the result as one JSON object on stdout
  --no-open, --no-agents, --url <url>, --timeout <s>
                     runtime dials for CI, a headless box, or an app you already run
  --dry-run          show the plan without writing anything
  --no-first-run     connect and stop; CI, --json and --no-open never drive
  --port N           the Reticle daemon port`;

const VERIFY_DETAIL = `Drives the URL and verifies the saved flows. Exit 0 means every one passed.

  --explore [--persona <who>]   no saved flows? let Reticle drive the app and record them
  --select <label>              repeatable: verify only flows carrying these labels
  --results-json <file>         also write one verdict per journey as JSON, for CI
  --storage-state <file>        start signed in
  --session-id <id>, --timeout N, --headed, --port N
  --expect '<json predicate>' | --expect-file <path>
                                one verdict, no saved flows needed. Asks a running daemon,
                                never starts one. Exit 0 only on verified:"yes". For an
                                action --expect cannot do, use the HTTP MCP transport:
                                https://docs.reticle.sh/http-transport.md`;

const BROWSER_NOTE = `The browser Reticle opens for your agent is shown so you can watch the run. --headless hides
it; CI, RETICLE_HEADLESS=1, or a Linux machine with no display hides it too.`;

const COMMANDS: readonly CommandDoc[] = [
  {
    name: 'init',
    synopsis: 'init [--app <dir>] [--env KEY=VALUE] [--no-mcp] [--files-only] [--dry-run]',
    summary: 'Wire Reticle into the app in this folder',
    group: HelpGroup.START,
    detail: INIT_DETAIL,
  },
  {
    name: 'connect',
    synopsis: 'connect [--project <name|id>] [--url <cloud origin>]',
    summary: 'Sign in and link this project to the dashboard',
    group: HelpGroup.START,
    detail:
      'Wires the app first if it is not wired, signs in through your browser, links this repo to\n' +
      'the project (created if it does not exist; named after the folder by default), and sends\n' +
      'local history.',
  },
  {
    name: 'try',
    synopsis: 'try <url> [--persona <who>]',
    summary: 'Watch Reticle drive a URL once and say which journeys work',
    group: HelpGroup.START,
    detail: 'Needs a signed-in account (`reticle connect`).',
  },
  {
    name: 'verify',
    synopsis: 'verify <url> [--explore] [--expect <json>]',
    summary: 'Check the saved flows against the running app; exit 0 means pass',
    group: HelpGroup.CHECK,
    detail: VERIFY_DETAIL,
  },
  {
    name: 'gate',
    synopsis: 'gate [--since <ref>] [--accept-coverage] [--hook] [file...]',
    summary: 'Fail unless passing checks cover the flows your changes touch',
    group: HelpGroup.CHECK,
  },
  {
    name: 'status',
    synopsis: 'status [--json] [--port N]',
    summary: 'Is Reticle running, is your app connected, are you signed in',
    group: HelpGroup.MACHINE,
  },
  {
    name: 'doctor',
    synopsis: 'doctor [--port N]',
    summary: 'Find what is wrong with the setup, and what is missing from coverage',
    group: HelpGroup.MACHINE,
  },
  {
    name: 'open',
    synopsis: 'open [url] [--port N]',
    summary: 'Show the app in the browser Reticle drives',
    group: HelpGroup.MACHINE,
  },
  {
    name: 'stop',
    synopsis: 'stop [--force] [--quiet] [--port N]',
    summary: 'Stop Reticle; --force frees its port even without a recorded pid',
    group: HelpGroup.MACHINE,
    detail:
      'Without --force, stops the daemon Reticle started, by its recorded pid.\n' +
      "With --force, frees the port by the Reticle daemon LISTENING on it, never the agent's MCP\n" +
      'proxy, and refuses a listener that is not Reticle.',
  },
  {
    name: 'restart',
    synopsis: 'restart [--force] [--port N]',
    summary: 'Stop Reticle, then start it and wait until it is listening',
    group: HelpGroup.MACHINE,
  },
  {
    name: 'update',
    synopsis: 'update',
    summary: 'Install the latest version and restart',
    group: HelpGroup.MACHINE,
  },
  {
    name: 'logout',
    synopsis: 'logout [--url <cloud origin>]',
    summary: 'Sign out (of one host; others stay signed in)',
    group: HelpGroup.ACCOUNT,
  },
  {
    name: 'feedback',
    synopsis: 'feedback [--rating 1-5] [--bug] "message"',
    summary: "Tell us what worked and what didn't; prints exactly what it sends",
    group: HelpGroup.ACCOUNT,
    detail:
      'Agents: reticle feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement|experience> "message"\n' +
      'works from anywhere, including a setup that never finished.',
  },
  {
    name: 'telemetry',
    synopsis: 'telemetry [status|enable|disable]',
    summary: 'Show or change anonymous usage metrics',
    group: HelpGroup.ACCOUNT,
  },
  {
    name: 'sync',
    synopsis: 'sync [--watch]',
    summary: 'Send local runs to the dashboard and collect decisions',
    group: HelpGroup.MORE,
  },
  {
    name: 'runs',
    synopsis: 'runs [<runId> | regression | share <runId> | issues [--fix <fp>] | memory]',
    summary: "Read the linked project's runs, regressions, issues and memory",
    group: HelpGroup.MORE,
    detail:
      '  runs                 recent runs\n' +
      '  runs <runId>         one run\n' +
      '  runs regression      flows broken since before; exits 3 if any\n' +
      '  runs share <runId>   mint a public proof link\n' +
      '  runs issues [--fix <fingerprint>]   the triage queue; --fix prints one fix prompt\n' +
      '  runs memory          what the project has learned',
  },
  {
    name: 'config',
    synopsis: 'config [--runs on|off] [--memory on|off] [--flows on|off] [--verify local|server]',
    summary: 'What this project sends to the dashboard',
    group: HelpGroup.MORE,
  },
  {
    name: 'affected',
    synopsis: 'affected [--since <ref>] [file...]',
    summary: 'Which saved flows must re-verify for the changed files',
    group: HelpGroup.MORE,
  },
  {
    name: 'report',
    synopsis: 'report [--session <id>] [--hook]',
    summary: 'What the latest session claimed, and what held',
    group: HelpGroup.MORE,
  },
  {
    name: 'mcp',
    synopsis: 'mcp [--port N] [--drive <url>] [--headless]',
    summary: 'The MCP stdio server your agent runs; starts the daemon if needed',
    group: HelpGroup.MORE,
    detail: BROWSER_NOTE,
  },
  {
    name: 'serve',
    synopsis:
      'serve [--port N] [--drive <url>] [--headless] [--http] [--http-port N] [--http-token T]',
    summary: 'Run the daemon in the foreground',
    group: HelpGroup.MORE,
    detail: BROWSER_NOTE,
  },
  {
    name: 'drive',
    synopsis: 'drive <url> [--headless]',
    summary: 'Open a URL in the foreground, for debugging',
    group: HelpGroup.MORE,
  },
  {
    name: 'setup',
    synopsis: 'setup mcp',
    summary: 'Register the MCP server with the coding agents on this machine',
    group: HelpGroup.MORE,
  },
  {
    name: 'license',
    synopsis: 'license',
    summary: 'Show the enterprise license status',
    group: HelpGroup.MORE,
  },
  {
    name: 'rollback',
    synopsis: 'rollback',
    summary: 'Restore the previous version and restart',
    group: HelpGroup.MORE,
  },
  {
    name: 'version',
    synopsis: 'version',
    summary: 'Print the version',
    group: HelpGroup.MORE,
  },
];

const HEAD = 'usage:  reticle <command>   (or npx @reticlehq/server <command>)';
const FOOT = 'All commands: reticle help all     One command: reticle <command> --help';
const NAME_COLUMN = COMMANDS.reduce((w, c) => Math.max(w, c.name.length), 0) + 3;

const line = (c: CommandDoc): string => `  ${c.name.padEnd(NAME_COLUMN)}${c.summary}`;

function grouped(groups: readonly HelpGroup[]): string[] {
  return groups.flatMap((g) => ['', g, ...COMMANDS.filter((c) => c.group === g).map(line)]);
}

const SHORT_GROUPS: readonly HelpGroup[] = [
  HelpGroup.START,
  HelpGroup.CHECK,
  HelpGroup.MACHINE,
  HelpGroup.ACCOUNT,
];

/** `reticle --help`: printed by `help`, `--help` and under every usage error. */
export const CLI_USAGE = [HEAD, ...grouped(SHORT_GROUPS), '', FOOT].join('\n');

/** `reticle help all`. */
export const CLI_USAGE_ALL = [HEAD, ...grouped([...SHORT_GROUPS, HelpGroup.MORE]), '', FOOT].join(
  '\n',
);

/** Every command the help names, for checks that each one really parses. */
export const DOCUMENTED_COMMANDS: readonly string[] = COMMANDS.map((c) => c.name);

/**
 * The help for one topic: the short page, every command, or one command's detail. An old name
 * answers with the page of the command that replaced it, and says so.
 */
export function renderHelp(
  topic: string | undefined,
  renamed: ReadonlyMap<string, string> = new Map(),
): string {
  if (topic === undefined) return CLI_USAGE;
  if (HELP_ALL_TOPIC === topic) return CLI_USAGE_ALL;
  const now = renamed.get(topic);
  const target = now?.split(' ')[0] ?? topic;
  const doc = COMMANDS.find((c) => c.name === target);
  if (doc === undefined) return CLI_USAGE;
  return [
    `usage:  reticle ${doc.synopsis}`,
    ...(now === undefined ? [] : [`        (\`reticle ${topic}\` is now \`reticle ${now}\`)`]),
    '',
    doc.summary,
    ...(doc.detail === undefined ? [] : ['', doc.detail]),
  ].join('\n');
}
