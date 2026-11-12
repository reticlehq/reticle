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
import { FEEDBACK_KIND_CHOICES } from '@reticlehq/core';

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

const INIT_DETAIL = `init wires the project, boots the app and proves a page connected. It ends with the
instrumentation score, what is missing, and a prompt for your coding agent, which proves
the first flow. It never drives: the Harness is opt-in and runs at any instrumentation score.

  --app <dir>        which app in a monorepo: writes its files only (add --start to boot it)
  --env KEY=VALUE    what the app needs to reach a usable state (repeatable)
  --files-only       write the files and stop; do not boot the app
  --no-install       do not install packages
  --new-id           give this checkout its own project id (a copied repo keeps the original's)
  --no-mcp           skip the MCP registration, the agent rule files and the /reticle command
  --hooks            also install the agent hooks
  --no-prompt-capture  install no hook that saves each prompt to .reticle/
  --relaunch         print the command that restarts this agent conversation with the tools loaded
  --license <key>    write an enterprise key to .env and keep .env out of git
  --json             print the result as one JSON object on stdout
  --no-open, --no-agents, --url <url>, --timeout <s>
                     runtime dials for CI, a headless box, or an app you already run
  --dry-run          show the plan without writing anything
  --no-first-run     connect and stop, without the coverage summary
  --port N           the Reticle daemon port`;

const VERIFY_DETAIL = `Drives the URL and verifies the saved flows. Exit 0 means every one passed.

  --explore [--persona <who>]   no saved flows? let Reticle drive the app and record them
  --against <reference-url>     compare the URL with a reference build: drive both with the same
                                actions, and report each difference in what users see (exit 1)
  --select <label>              repeatable: verify only flows carrying these labels
  --results-json <file>         also write one verdict per journey as JSON, for CI
  --confirm-dangerous           this run may press what the replay guard holds as destructive
  --require-start-control       fail a flow whose first control is not on its freshly loaded start page
  --sweep                       judge every step, also after one fails (the results score counts them all)
  --storage-state <file>        start signed in
  --session-id <id>, --timeout <ms>, --headed, --port N
  --expect '<json predicate>' | --expect-file <path>
                                one verdict, no saved flows needed. Asks a running daemon,
                                never starts one, and waits up to --timeout ms (default 4000)
                                for it to come true. Exit 0 only on verified:"yes". For an
                                action --expect cannot do, use the HTTP MCP transport:
                                https://docs.reticle.sh/http-transport.md`;

const GRADE_DETAIL = `Grades a finished run of an app from snapshots of its stored data. It needs no
daemon and no browser.

  grade snapshot --state <file> --out <file> [--url <url>]
      read the declared state sources (and the page the run ended on) into a snapshot
  grade judge --reference <file> --again <file> --candidate <file>
              [--expect <file>] [--answer <text>] [--json]
      compare the candidate snapshot with two snapshots of the correct run. A line that
      differs between the two correct runs is ignored. --expect declares a source whose
      rows are the correct answer, read now. Exit 0 = pass, 1 = fail, 2 = unverified
  grade tables --list <command> --rows <template> [--container <name>] [--skip <regex>]
               --out <file>
      write a declaration with one source for each table; {table} in the template is
      the table name; --skip leaves out the tables whose name matches
  grade suggest --state <file> --reference <file> --again <file> --out <file>
      keep only the sources that read the same on two correct runs`;

const COMPARE_DETAIL = `Drives two running builds of one app the same way, for example main and a pull request
preview, and reports each difference in what a person sees and in the requests and console
errors the app made. Install nothing in the app.

It plans every action on every control of the reference, drives the plan on the reference two
times and on the candidate one time, and ignores what changes between the two reference runs.
Point it at builds whose data you can change: it presses every button it finds.

  --base <url>     the build before the change: tag each difference as a regression, a missed
                   target or a change, and print a score
  --state <file>   a JSON file { "sources": [...] } that declares how to read the app's stored
                   data (kind command, http or file). Compare reads it after each sequence on
                   every build, so a change to a record that no page shows is a difference.
                   Start each row with the record id, so a changed row names its record
  --json           print one JSON object
Exit 0 = same, 1 = different, 2 = the run proves nothing (a lost browser session, or an error).`;

const BROWSER_NOTE = `The browser Reticle opens for your agent is shown so you can watch the run. --headless hides
it; CI, RETICLE_HEADLESS=1, or a Linux machine with no display hides it too.`;

/** What `--http` starts. MCP is already on the bridge port; this flag is the verify endpoint. */
const HTTP_HELP = '--http starts the verify endpoint. MCP is already served on the bridge port.';

const DAEMON_DETAIL = `${BROWSER_NOTE}\n\n${HTTP_HELP}`;

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
    synopsis: 'connect [--project <name|id>] [--workspace <name|id>] [--url <cloud origin>]',
    summary: 'Sign in and link this project to the dashboard',
    group: HelpGroup.START,
    detail:
      'Wires the app first if it is not wired, signs in through your browser, links this repo to\n' +
      'the project (created if it does not exist; named after the projectId in .reticle.json, else\n' +
      'the folder), says which workspace it is in, and sends local history. Linked before to\n' +
      "another workspace, the folder's earlier runs, flows and records stay here: `reticle sync --move-history`.\n\n" +
      '  --project <name|id>    the dashboard project to link\n' +
      '  --workspace <name|id>  the workspace to link in, when you belong to more than one\n' +
      '  --url <origin>         the Reticle platform, when it is not the default\n\n' +
      'Sign-in is with Google or GitHub, in the browser. Without a browser (CI, an agent), set\n' +
      'RETICLE_API_KEY to a key from Settings > API keys. Email sign-in is gone.',
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
    summary:
      'Check saved flows, or one claim with --expect, against the running app; exit 0 = pass',
    group: HelpGroup.CHECK,
    detail: VERIFY_DETAIL,
  },
  {
    name: 'compare',
    synopsis:
      'compare <reference-url> <candidate-url> [--base <url>] [--state <file>] [--json] [--report <file>]',
    summary: 'Drive two builds the same way and list what users would see change',
    group: HelpGroup.CHECK,
    detail: COMPARE_DETAIL,
  },
  {
    name: 'grade',
    synopsis: 'grade <snapshot|judge|tables|suggest> [flags]',
    summary: "Grade a finished run from snapshots of the app's stored data",
    group: HelpGroup.MORE,
    detail: GRADE_DETAIL,
  },
  {
    name: 'gate',
    synopsis: 'gate [--list] [--since <ref>] [--accept-coverage] [--hook] [file...]',
    summary: 'Fail unless passing checks cover the flows your changes touch',
    group: HelpGroup.CHECK,
    detail: '--list names the saved flows your changes touch, and checks nothing.',
  },
  {
    name: 'status',
    synopsis: 'status [--json] [--port N]',
    summary: 'Is Reticle running, is your app connected, are you signed in',
    detail: 'Shows the enterprise license when a key is set. --json always carries it.',
    group: HelpGroup.MACHINE,
  },
  {
    name: 'doctor',
    synopsis: 'doctor [--fix] [--port N]',
    summary: 'Find what is wrong with the setup, and what is missing from coverage',
    detail: '--fix repairs what Reticle can repair safely, and names the step for the rest.',
    group: HelpGroup.MACHINE,
  },
  {
    name: 'open',
    synopsis: 'open [url] [--port N] [--navigate]',
    summary: 'Open the app in your browser, or reuse a tab that is already connected',
    group: HelpGroup.MACHINE,
    detail: '--navigate moves a tab already on that origin to the url instead of leaving it.',
  },
  {
    name: 'stop',
    synopsis: 'stop [--force] [--quiet] [--port N]',
    summary: 'Stop Reticle; --force frees its port even without a recorded pid',
    group: HelpGroup.MACHINE,
    detail:
      'Without --force, asks the daemon to stop (an authenticated request on loopback), and sends\n' +
      'a signal to its recorded pid only if it does not accept.\n' +
      "With --force, frees the port by the Reticle daemon LISTENING on it, never the agent's MCP\n" +
      'proxy, and refuses a listener that is not Reticle.',
  },
  {
    name: 'update',
    synopsis: 'update [--rollback]',
    summary: 'Install the latest version and restart',
    group: HelpGroup.MACHINE,
    detail: '--rollback restores the previous version and restarts.',
  },
  {
    name: 'logout',
    synopsis: 'logout [--url <cloud origin>]',
    summary: 'Sign out (of one host; others stay signed in)',
    group: HelpGroup.ACCOUNT,
  },
  {
    name: 'feedback',
    synopsis: 'feedback [--rating 1-5] [--bug] [--contact <email>] "message"',
    summary: "Tell us what worked and what didn't; prints exactly what it sends",
    group: HelpGroup.ACCOUNT,
    detail:
      `Agents: reticle feedback --agent --kind ${FEEDBACK_KIND_CHOICES} "message"\n` +
      'works from anywhere, including a setup that never finished.\n' +
      '--contact <email> adds an address for a reply. It is sent only when you give it.',
  },
  {
    name: 'telemetry',
    synopsis: 'telemetry [status|enable|disable]',
    summary: 'Show or change anonymous usage metrics',
    group: HelpGroup.ACCOUNT,
  },
  {
    name: 'sync',
    synopsis: 'sync [--watch] [--move-history]',
    summary: 'Send local runs to the dashboard and collect decisions',
    group: HelpGroup.MORE,
    detail:
      '  --watch          keep sending as runs are written\n' +
      '  --move-history   also send runs, flows and records made under the previous link',
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
    synopsis:
      'config [--runs on|off] [--memory on|off] [--flows on|off] [--verify local|server] [--harness on|off]',
    summary: 'What this project sends to the dashboard',
    group: HelpGroup.MORE,
  },
  {
    name: 'report',
    synopsis: 'report [--session <id>] [--hook]',
    summary: 'What the latest session claimed, and what held',
    group: HelpGroup.MORE,
  },
  {
    name: 'context',
    synopsis: 'context --compact [--session <id>]',
    summary: 'Resume after a compaction: what was proved, failed and is still owed',
    group: HelpGroup.MORE,
  },
  {
    name: 'hook',
    synopsis:
      'hook [install|uninstall|status|prompt --agent <id>|tool --agent <id>|export --structure]',
    summary:
      'Save prompts, tool calls, the model and closing messages to .reticle/, through your agent hooks',
    group: HelpGroup.MORE,
    detail:
      '  hook install      add the prompt-capture hook for the agents used here\n' +
      '  hook uninstall    remove exactly the entries hook install added\n' +
      '  hook status       which agents capture prompts, and which rely on the MCP instructions\n' +
      '  hook prompt --agent <id>   what the agent hook runs; reads the prompt on stdin\n' +
      '  hook tool --agent <id>     what the post-tool hook runs; keeps the call in .reticle/episodes/\n' +
      '  hook export --structure    each snapshot step in .reticle/episodes/ as text-free page structure (JSONL)\n\n' +
      'One switch stops prompts, tool calls, the model and the closing message. Off for one project:\n' +
      '"promptCapture": false in .reticle.json. Off on this machine: RETICLE_PROMPT_CAPTURE=0.\n' +
      'Tool calls also stop with the journal: "journal": false or RETICLE_JOURNAL=0.',
  },
  {
    name: 'mcp',
    synopsis:
      'mcp [--port N] [--drive <url>] [--headless] [--headed] [--http] [--http-port N] [--http-token T]',
    summary: 'The MCP stdio server your agent runs; starts the daemon if needed',
    group: HelpGroup.MORE,
    detail: DAEMON_DETAIL,
  },
  {
    name: 'serve',
    synopsis:
      'serve [--port N] [--drive <url>] [--headless] [--headed] [--http] [--http-port N] [--http-token T]',
    summary: 'Start the daemon in the background; returns once it answers',
    group: HelpGroup.MORE,
    detail: `--restart [--force] stops Reticle, then starts it and waits until it listens.\n\n${DAEMON_DETAIL}`,
  },
  {
    name: 'drive',
    synopsis: 'drive <url> [--headless] [--headed]',
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
  if (topic === undefined) {
    return CLI_USAGE;
  }
  if (HELP_ALL_TOPIC === topic) {
    return CLI_USAGE_ALL;
  }
  const now = renamed.get(topic);
  const target = now?.split(' ')[0] ?? topic;
  const doc = COMMANDS.find((c) => c.name === target);
  if (doc === undefined) {
    return CLI_USAGE;
  }
  return [
    `usage:  reticle ${doc.synopsis}`,
    ...(now === undefined ? [] : [`        (\`reticle ${topic}\` is now \`reticle ${now}\`)`]),
    '',
    doc.summary,
    ...(doc.detail === undefined ? [] : ['', doc.detail]),
  ].join('\n');
}
