/**
 * The last thing `init` prints, and the only part of it a user is asked to act on.
 *
 * Its own file because it is its own concern: everything else in `run.ts` decides what to write,
 * and this decides what to say afterwards. The failure modes differ too — a wrong write breaks an
 * install, a wrong sentence loses a user quietly.
 */

import { FEEDBACK_KIND_CHOICES } from '@reticlehq/core';
import { StepStatus } from '@/plan/plan.js';
import { wasMcpRegistered } from '@/register/mcp-registered.js';
import { CLI } from '@/project/agent-rules.js';

/**
 * The standing ask, printed at the end of every `init`.
 *
 * Addressed to the agent as much as the human: whichever of them just ran this command is the one
 * holding the experience, and neither has a Reticle tool surface to file through at this point.
 *
 * Printed by the `runInit` wrapper, NOT by `report()` — see the comment there for why, and for how
 * the workspace redirect is kept from asking twice.
 */
export const FEEDBACK_HINT =
  'Anything wrong, missing, or awkward — in this setup or in Reticle itself? Tell us; it is the ' +
  'one thing that decides what gets fixed:\n' +
  `  ${CLI} feedback --agent --kind ${FEEDBACK_KIND_CHOICES} "what happened"   (agents)\n` +
  `  ${CLI} feedback "what worked, what didn't"   (humans)`;

/**
 * The last line of a successful `init`, after the ask: where the user can tell the maintainers what
 * they build. Only on success: on a failure, the ask above is the thing to do.
 */
export const COMMUNITY_HINT = 'Tell us what you are building: https://discord.gg/BwAbzv9ZRz';

/** User-facing closing copy for `restartHint` — one named home per sentence block. */
const RestartHintCopy = {
  PROVE:
    'Then run `npx @reticlehq/server status` — it confirms the app connected, or says exactly why ' +
    'it has not.',
  ALREADY_REGISTERED_ALL:
    'The Reticle MCP server was already registered on this machine, so there is no restart to do ' +
    'and the tools are available now.',
  ALREADY_REGISTERED_CLAUDE_HEAD:
    'The Reticle MCP server was already registered with Claude Code, so there is no restart to ' +
    'do and the tools are available there now. They are NOT available in the clients whose ' +
    'step above still needs a hand edit (',
  ALREADY_REGISTERED_CLAUDE_TAIL: ') until that is done.',
  CLOSING_NO_MCP:
    'Once it shows a session, drive one flow and report the verdict — that is the install finished.',
  CLOSING_ALREADY_NO_MANUAL:
    'Once it shows a session, drive one flow and report the verdict — that is the install ' +
    'finished. Carry straight on; ' +
    'nothing here is waiting on a human.',
  CLOSING_ALREADY_WITH_MANUAL:
    'Once it shows a session, drive one flow and report the verdict where the tools are already ' +
    'available — that is the ' +
    'install finished on that client. The hand-edit step above still needs a human for the other ' +
    'clients named there.',
} as const;

/**
 * What to say about the dev server.
 *
 * Names the project's own script when `package.json` has a recognisable one, and otherwise says the
 * THING rather than guessing the command.
 *
 * The guesses that used to live here — `vite`, `next dev`, `astro dev` — were wrong often enough to
 * be worth deleting. Measured on a real app: rowy has no `dev` script at all, so "Restart `vite`"
 * sent the reader to work out what was meant instead of starting a server. Nobody needs the guess:
 * an agent reading this can open package.json, and a human already knows how they start their own
 * app. A wrong command costs more than a missing one.
 */
function devServerRestart(devCommand?: string): string {
  return devCommand === undefined
    ? 'Restart your dev server'
    : `Restart your dev server (\`${devCommand}\`)`;
}

/**
 * The last two lines a user reads, and the order matters.
 *
 * This used to say only "Restart <dev server>, then ask your agent: List Reticle sessions" — and
 * asking the agent was the one thing that could not work yet. `init` registers the MCP server, but
 * an agent client reads its tool list when it STARTS and never re-reads it, so the session that
 * just ran `init` has no `reticle_*` tools however clean the install was. The user follows the
 * instruction, the agent answers "unknown tool", and the obvious conclusion is that the install
 * failed.
 *
 * So the reload is named FIRST, before the sentence that depends on it. Omitted entirely when this
 * run did not register MCP (`--no-mcp`), where it would be advice about something we did not do.
 */
export function restartHint(
  mcpStatus: StepStatus | undefined,
  /** The project's own dev command, when package.json named one. */
  devCommand?: string,
  /**
   * Titles of other clients' registration steps this run left for the reader (the `⚠` rows). The
   * Claude Code row says nothing about them, so without these the closing line contradicts the
   * report above it.
   */
  manualClients: readonly string[] = [],
): string {
  const dev = `${devServerRestart(devCommand)}.`;
  // NAME THE COMMAND THAT PROVES IT, not one that merely asks.
  //
  // `init` writes files and stops; the install is not finished until an app carrying the SDK has
  // actually dialled the daemon, and nothing here confirmed that — so this is the last instruction
  // a user reads before the half that can still fail.
  //
  // "Ask your agent: List Reticle sessions" asks a question whose failure is a dead end. `reticle
  // status` ANSWERS it: it reports the session, or says why there is none — no app running, an app
  // running that never dialled us, a tab that closed — with the fix for each. It works BEFORE the
  // restart, so it goes before it.
  //
  // What comes after the restart, named as a JOB rather than as a capability.
  //
  // This used to point at a `reticle demo` command that opened its own browser and drove one
  // control. It was cut: a demo command is a side show. The thing a user needs to see is THEIR app,
  // instrumented in THEIR codebase, driven by THEIR agent through the tools they just installed —
  // because that is the workflow they are deciding whether to adopt, and a bespoke demo path proves
  // nothing about it.
  //
  // So the close hands the agent the sequence instead. It is deliberately one drive of one real
  // flow ending in a verdict, because an install that ends in "the tools are available" is an
  // install that ends in nothing. It is said ONCE, last: after the status check and after the client
  // restart, because that is the order in which a reader can do it.
  const prove = RestartHintCopy.PROVE;
  // Nothing registered this run (`--no-mcp`, or a client that needs a manual edit): a restart picks
  // up nothing, so advice about one would be advice about something we did not do.
  if (!wasMcpRegistered(mcpStatus)) {
    return `${dev}\n${prove}\n${RestartHintCopy.CLOSING_NO_MCP}`;
  }
  // ALREADY: the tools are reachable RIGHT NOW, and this is the branch that used to lie.
  //
  // `wasMcpRegistered` is true for both APPLY and ALREADY, which is wrong here: the two cases have
  // opposite answers to "must anybody restart". ALREADY used to take the APPLY text — "restart your
  // agent, the tools only appear after that" — and an agent believes the output in front of it over
  // whatever its skill file said, so it stops with the project wired and nothing driven.
  if (mcpStatus === StepStatus.ALREADY) {
    // Only Claude Code's row was read, so "available now" is true for Claude Code and nothing else.
    // Name the registrations still left, or a Codex user reads two contradicting lines and believes
    // the last one.
    const availability =
      0 === manualClients.length
        ? RestartHintCopy.ALREADY_REGISTERED_ALL
        : RestartHintCopy.ALREADY_REGISTERED_CLAUDE_HEAD +
          manualClients.join(', ') +
          RestartHintCopy.ALREADY_REGISTERED_CLAUDE_TAIL;
    const closing =
      0 === manualClients.length
        ? RestartHintCopy.CLOSING_ALREADY_NO_MANUAL
        : RestartHintCopy.CLOSING_ALREADY_WITH_MANUAL;
    return `${dev}\n${availability}\n${prove}\n${closing}`;
  }
  return (
    `${dev}\n` +
    'Then restart your agent so it picks up the new MCP server. On Claude Code and Codex, do NOT ' +
    'ask a human to do it: `npx @reticlehq/server init --relaunch` prints the exact resume command ' +
    'for THIS conversation — run that command and the restart continues the work on the other ' +
    'side. Everywhere else it is a human step — reload the window in Cursor, or hit Start in ' +
    '`.vscode/mcp.json` in VS Code — so name the one that applies and ask for that alone.\n' +
    'The tools only appear after that: your agent read its server list before Reticle existed, ' +
    'and no slash command re-reads it (`/mcp` manages servers already loaded, so it cannot pick ' +
    'up a new one). This is once per machine — Reticle is registered globally, so every later ' +
    'project starts with the tools already there.\n' +
    `${prove}\n` +
    'Once it shows a session, drive one flow and report the verdict — that is the install ' +
    'finished. Do it now; nothing here is waiting on a human.'
  );
}
