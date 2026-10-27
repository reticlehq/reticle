import { statusNextAction } from './answers/status-next-action.js';
import {
  daemonsServingProjectElsewhere,
  resolveDaemonForProject,
  splitBrainNote,
  wrongDaemonNote,
} from '@/command/daemon/daemon-resolve.js';
import { isAlive, readPid, reticleStateHome } from '@/command/daemon/daemon.js';
import {
  hasAnyAppConnectedBefore,
  hasProjectConnectedBefore,
} from '@/memory/recall/prior/connection-memory.js';
import { devServersForProject } from '@reticlehq/core';
import { readDevServers } from '@/command/daemon/dev-servers.js';
import { attachStatusFields } from '@/surface/mcp/attach-memory.js';
import { probeDaemon } from '@/surface/mcp/mcp-proxy.js';
import { availableUpdate } from '@/command/update/update-nudge.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import {
  PortPresence,
  probePresence,
  presenceIsUsable,
} from '@/command/daemon/binding/port-presence.js';
import { describePortState } from '@/command/daemon/port-state.js';
import { summarizeStatus } from './launch/cli-launch.js';
import { readProjectId } from './ports/resolve/cli-port.js';
import { accountStatusFields } from './cloud-cli.js';
import { localLinkOf, workspaceAppLinks } from './status/workspace-links.js';
import { statusLines } from './status/status-lines.js';

/**
 * `reticle status`: what it reads and reports, and the two optional blocks it adds to its payload.
 * Out of cli.ts because that file hit the 1000-line cap and the rule is to split rather than raise it.
 *
 * They belong together: both answer "is there anything else the reader needs to know", both are
 * absent when the answer is no, and both are the reason a healthy `status` reads as healthy.
 */

/** `{ nextAction }` when there is one, `{}` when a session is connected — so the success case is silent. */
export function withNextAction(facts: {
  running: boolean;
  sessionCount: number;
  previouslyConnected: boolean;
  projectPreviouslyConnected: boolean;
  initialized: boolean;
  devServerPorts?: readonly number[];
}): { nextAction?: string } {
  const next = statusNextAction(facts);
  return next === undefined ? {} : { nextAction: next };
}

/**
 * What `status` says about a project whose daemons have split in two.
 *
 * Both halves in one place because they are one condition asked from two positions, and a command
 * can be standing on either. Silent — no key at all — when there is nothing to report, so a healthy
 * run reads exactly as it did.
 */
export function splitBrainFields(
  port: number,
  projectId: string | undefined,
): { splitBrain?: string } {
  const home = reticleStateHome();
  const elsewhere = splitBrainNote(
    port,
    daemonsServingProjectElsewhere(projectId, port, home, isAlive, (other: number) =>
      hasProjectConnectedBefore(home, other, projectId),
    ),
  );
  const note =
    elsewhere ?? wrongDaemonNote(port, resolveDaemonForProject(projectId, home, isAlive));
  return note === undefined ? {} : { splitBrain: note };
}

/**
 * Report status to the terminal. `--json` writes one structured line to STDOUT so it can be piped
 * into `jq`; the human-readable block goes to stdout too. `log()` stays on stderr (the MCP
 * transport lives on stdout), so `--json` must not go through it.
 */
export function reportStatus(fields: Record<string, unknown>, json: boolean): void {
  if (json) {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      event: 'reticle_status',
      ...fields,
    });
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${statusLines(fields).join('\n')}\n`);
}

export async function handleStatus(port: number, json = false): Promise<void> {
  // A broken session file must not cost the reader the rest of the status.
  const account = await accountStatusFields().catch(() => ({}));
  // At a workspace root that is no app of its own, each app and its link: "not linked" named none.
  const linked = (account as { linkedProject?: unknown }).linkedProject;
  if ('string' !== typeof linked && readProjectId(process.cwd()) === undefined) {
    Object.assign(account, {
      workspaceApps: await workspaceAppLinks(process.cwd(), localLinkOf).catch(() => []),
    });
  }
  const report = (fields: Record<string, unknown>): void =>
    reportStatus({ ...fields, ...account }, json);
  const pid = readPid(port);
  // Durable, so it survives the daemon idling out — which is the state `status` is most often run in.
  const projectId = readProjectId(process.cwd());
  const previouslyConnected = hasAnyAppConnectedBefore(reticleStateHome(), port, projectId);
  // The narrow twin. Every sentence that says "this project", and the decision about whether THIS
  // app is instrumented, needs the question the wide one cannot answer without a project id.
  const projectPreviouslyConnected = hasProjectConnectedBefore(reticleStateHome(), port, projectId);
  // Whether `init` has run HERE. Registering the MCP server does not wire the app, and more than one
  // path does the first without the second — so this is the commonest reason `status` has nothing to
  // report, and it was not among the facts this command could state.
  const initialized = projectId !== undefined;
  // The OTHER half of the install, and the half this command could not see. A host that registers
  // Reticle and never lists its tools looks exactly like an abandoned install from here — same idle
  // daemon, same zero sessions — and the user sees a tool that does nothing. See attach-memory.ts.
  const client = attachStatusFields(reticleStateHome(), port);
  // What the dev servers themselves said. The reason this command could previously only guess at
  // whether the app was running is that it had no way to see one; now the ones carrying Reticle
  // announce, and the advice below stops contradicting the terminal the reader is looking at.
  // Scoped to THIS project: the registry is machine-wide, and an unrelated app's dev server must
  // not make this project look like it is running.
  const devServerPorts = devServersForProject(readDevServers(reticleStateHome()), {
    projectId,
    root: process.cwd(),
  }).map((d) => d.port);
  // The failure where every individual check is green and the chain is broken: the agent's proxy and
  // the app resolved their ports independently and landed on two different daemons. Reported from
  // BOTH stances, because neither one can see it alone.
  const split = splitBrainFields(port, projectId);
  // Doctor and status must answer the same liveness question. A live pid only says that some
  // process exists; a Reticle daemon is running only when the shared port probe reaches /status.
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  if (!presenceIsUsable(presence)) {
    report({
      port,
      running: false,
      presence,
      ...(presence === PortPresence.FOREIGN ? { reason: describePortState(presence, port) } : {}),
      // `init` promises this command says why the app has not connected. Without it the answer was
      // `running: false` and nothing else, which reads as "Reticle is broken" for what is usually
      // just a daemon that has not been asked to do anything yet.
      ...withNextAction({
        running: false,
        sessionCount: 0,
        previouslyConnected,
        projectPreviouslyConnected,
        initialized,
        devServerPorts,
      }),
      ...client,
      ...split,
    });
    return;
  }
  // The daemon answered the same probe doctor trusts — ask it for live sessions + health.
  const payload = await fetchStatus(port);
  // `status` is the second-most-run command and the one a HUMAN types. The update nudge otherwise
  // only rides a tool result, which the majority of daemons never produce — so the people most in
  // need of an upgrade were the ones with no path to hearing about it.
  const update = availableUpdate();
  const nudge = update === undefined ? {} : { updateAvailable: update };
  if (payload === undefined) {
    report({
      port,
      running: true,
      pid,
      ...nudge,
      ...withNextAction({
        running: true,
        sessionCount: 0,
        previouslyConnected,
        projectPreviouslyConnected,
        initialized,
        devServerPorts,
      }),
      ...client,
      ...split,
    });
    return;
  }
  const summary = summarizeStatus(payload);
  // Only when the daemon did NOT already explain itself. It has the whole diagnosis in-process and
  // puts it on the wire as `why`; printing a second, thinner opinion beside it risks two confident
  // answers pointing different ways, which is worse than one.
  const next =
    summary.why === undefined
      ? withNextAction({
          running: true,
          ...summary,
          previouslyConnected,
          projectPreviouslyConnected,
          initialized,
          devServerPorts,
        })
      : {};
  report({
    port,
    running: true,
    pid,
    ...summary,
    ...next,
    ...client,
    ...split,
    ...nudge,
  });
}
