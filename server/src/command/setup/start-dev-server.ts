/**
 * Start a project's dev script and wait until it serves a page, for a command that is not `init`.
 *
 * The same pieces `init` uses: the supervised `OwnedDevServer`, the URL it announces or the port its
 * process tree binds, and `judgeWait` for ready, dead or hung. `init` keeps its own loop because it
 * also reports progress and hands the server over; this one stops the server when the caller is done.
 */
import { OwnedDevServer, probePage } from './node-effects.js';
import {
  WaitVerdict,
  devServerDiedMessage,
  judgeWait,
  portBusyMessage,
  urlToWatch,
} from './bringup/dev-server-wait.js';

const POLL_MS = 500;
const MS_PER_S = 1000;

/** The url it serves and how to stop it, or why it did not serve. */
export type StartedDevServer = { url: string; stop: () => void } | { failed: string };

export async function startDevServerAndWait(
  command: string,
  dir: string,
  budgetMs: number,
): Promise<StartedDevServer> {
  const server = new OwnedDevServer();
  server.start(command, dir, {});
  const startedAt = Date.now();
  for (;;) {
    const watching = urlToWatch(server.output(), server.listeningPorts());
    const probe = watching === undefined ? undefined : await probePage(watching);
    const verdict = judgeWait({
      output: server.output(),
      launcherExited: server.exited(),
      serving: true === probe?.served,
      quietForMs: server.quietForMs(),
      elapsedMs: Date.now() - startedAt,
      budgetMs,
    });
    if (WaitVerdict.READY === verdict && watching !== undefined) {
      return { url: probe?.reachedUrl ?? watching, stop: () => server.stop() };
    }
    if (WaitVerdict.DEAD === verdict) {
      const failed = portBusyMessage(server.output()) ?? devServerDiedMessage(server.output());
      server.stop();
      return { failed };
    }
    if (WaitVerdict.HUNG === verdict) {
      server.stop();
      return {
        failed: `The dev server did not serve a page in ${String(budgetMs / MS_PER_S)}s.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
