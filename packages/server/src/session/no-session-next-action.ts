/**
 * "No browser session connected", as something an agent can RUN.
 *
 * The prose diagnosis next door is good and it is prose: the agent has to read four hedged sentences
 * and decide which of them is about its situation. This is the same decision, decided here, as one
 * value plus one literal command — so the branch happens in the daemon, which has the evidence,
 * rather than in the agent, which does not.
 *
 * The rule that outranks helpfulness: never invent a command. If the project has no dev script, this
 * says there is none. A command that does not exist sends the agent chasing a phantom error in its
 * own repo.
 *
 * Pure. The facts arrive from the watch; nothing here touches the disk or the clock.
 */

import { NoSessionAction } from '@reticlehq/core';
import type { DevCommand } from './dev-command.js';

/** The executable half of the no-session payload. */
export interface NoSessionNextAction {
  action: NoSessionAction;
  /** The literal command to run. Absent whenever it could not be sourced without guessing. */
  command?: string;
  /** The port this action is about — where the app is, or where the dev script will put it. */
  port?: number;
  /** One sentence: why this is the action, and — when there is no command — why there is none. */
  reason: string;
}

interface NextActionFacts {
  everConnected: boolean;
  initialized: boolean;
  listening: readonly number[];
  dev: DevCommand | undefined;
  /**
   * An app for this project has connected on this port before, from durable state.
   *
   * Outranks `initialized`, which is only ever "is there a `.reticle.json` in the ONE directory this
   * daemon stands in". In a monorepo, or under an editor that starts the MCP server from the user's
   * home, that answer is no for projects that are wired and have connected — and the action handed
   * back was `reticle init`, which is the one action that cannot help and can overwrite the config
   * that works.
   */
  previouslyConnected?: boolean;
}

/** `reticle init`, the only command here that is Reticle's own and so cannot be wrong. */
const INIT_COMMAND = 'reticle init';
const OPEN_COMMAND = 'reticle open';
const LOCALHOST = 'http://localhost';

export function nextActionFor(facts: NextActionFacts): NoSessionNextAction {
  if (facts.everConnected) {
    return {
      action: NoSessionAction.REOPEN_APP,
      reason:
        'a session was connected to this daemon earlier, so the wiring is correct — the tab was ' +
        'closed, reloaded, or the lease aged out. Reopen the app, or take one you own with ' +
        'reticle_lease {action:"acquire", url}.',
    };
  }

  if (0 === facts.listening.length) {
    const dev = facts.dev;
    if (dev === undefined) {
      return {
        action: NoSessionAction.START_DEV_SERVER,
        reason:
          'nothing is listening on the ports Reticle scans, so the app is probably not running — ' +
          'but this project declares no dev script (no `dev`, `develop` or `start` in its ' +
          'package.json), so there is no command to hand you. Ask the human how their app is ' +
          'started, and for the URL it serves on.',
      };
    }
    return {
      action: NoSessionAction.START_DEV_SERVER,
      command: dev.command,
      ...(dev.port === undefined ? {} : { port: dev.port }),
      reason:
        'nothing is listening on the ports Reticle scans, so the app is not running. This is the ' +
        `project's own \`${dev.script}\` script — run it in the background, tell the human it is ` +
        'running, then call reticle_sessions again.',
    };
  }

  // Something IS up. Whatever else is true, do NOT hand back a start command: a second dev server on
  // a second port is the exact confusion the probe exists to prevent.
  const ports = facts.listening.join(', ');
  const only = 1 === facts.listening.length ? facts.listening[0] : undefined;

  if (!facts.initialized && true !== facts.previouslyConnected) {
    return {
      action: NoSessionAction.RUN_INIT,
      command: INIT_COMMAND,
      ...(only === undefined ? {} : { port: only }),
      reason:
        `something is listening (${ports}) but no \`.reticle.json\` was found, so the app may ` +
        "carry no Reticle SDK. Run this in the APP's own directory — in a monorepo that is not " +
        'where this daemon stands — then restart the dev server.',
    };
  }

  if (only === undefined) {
    return {
      action: NoSessionAction.OPEN_APP,
      reason:
        `this project is wired and no page is open. Several ports are listening (${ports}) and ` +
        'none of them can be attributed to this project, so open the one the human names: ' +
        `\`${OPEN_COMMAND} <url>\`.`,
    };
  }
  return {
    action: NoSessionAction.OPEN_APP,
    command: `${OPEN_COMMAND} ${LOCALHOST}:${String(only)}`,
    port: only,
    reason:
      'this project is wired and a dev server is listening — Reticle only ever sees a page a ' +
      'browser has LOADED, and nothing has loaded one.',
  };
}

/** The same action as one sentence, for the prose message the human reads. */
export function renderNextAction(next: NoSessionNextAction): string {
  const command = next.command;
  return command === undefined
    ? `NEXT ACTION: ${next.reason}`
    : `NEXT ACTION: run \`${command}\` — ${next.reason}`;
}
