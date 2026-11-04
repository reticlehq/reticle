/**
 * `reticle open` and every other flow that needs a daemon on `port`.
 *
 * The retry: a FOREIGN reading seconds after `reticle restart` is usually OUR OWN daemon still
 * answering its first `/status` — the 1 s `/status` window and the 500 ms TCP window do not
 * survive a cold Windows start, and the refusal then names a holder it could not identify, while
 * `reticle status` run moments later shows the daemon fine. The pid file names what `restart`
 * started; while that process is alive the port is probed once more before refusing. A stranger's
 * pid is never in the file, so the refusal keeps its teeth for the stranger case it was written
 * for.
 *
 * Probes, the pid file and the spawn are injected so the rule is testable without a socket — the
 * same shape `probePresence`'s own callers use.
 */
import {
  PortPresence,
  probePresence,
  presenceIsUsable,
} from '@/command/daemon/binding/port-presence.js';
import { describePortState } from '@/command/daemon/port-state.js';
import { probeDaemon, waitForDaemon } from '@/surface/mcp/mcp-proxy.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { isAlive, readPid, spawnDaemon } from '@/command/daemon/daemon.js';
import { warnOnDaemonSkew } from './launch/cli-launch.js';
import { DAEMON_INNER_COMMAND, PORT_FLAG } from './cli-parse.js';

/** The probe pair every daemon-touching command shares. */
const REAL_PROBES = {
  tcpOpen: (port: number) => probeDaemon(port),
  status: (port: number) => fetchStatus(port),
};

export interface EnsureDaemonDeps {
  /** The classified presence probe. Defaults to the shared TCP + `/status` pair. */
  probe?: (port: number) => Promise<PortPresence>;
  readPid?: (port: number) => number | null;
  isAlive?: (pid: number) => boolean;
  /** How long to wait before the second probe. */
  retryDelayMs?: number;
  spawnDaemon?: (port: number) => Promise<void>;
  onUsable?: (port: number) => Promise<void> | void;
}

export async function ensureDaemon(port: number, deps: EnsureDaemonDeps = {}): Promise<void> {
  const probe = deps.probe ?? (() => probePresence(port, REAL_PROBES));
  const readRecordedPid = deps.readPid ?? readPid;
  const pidIsAlive = deps.isAlive ?? isAlive;
  const spawn = deps.spawnDaemon ?? spawnRealDaemon;
  const onUsable = deps.onUsable ?? warnOnDaemonSkew;
  const retryDelayMs = deps.retryDelayMs ?? 1_500;

  let presence = await probe(port);

  if (PortPresence.FOREIGN === presence) {
    const recorded = readRecordedPid(port);
    if (recorded !== null && pidIsAlive(recorded)) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      presence = await probe(port);
    }
  }

  if (presenceIsUsable(presence)) {
    return void (await onUsable(port));
  }

  if (PortPresence.FREE !== presence) {
    throw new Error(describePortState(presence, port));
  }

  await spawn(port);
}

async function spawnRealDaemon(port: number): Promise<void> {
  const scriptPath = process.argv[1];
  if (scriptPath === undefined) {
    throw new Error('cannot locate the reticle daemon script');
  }
  spawnDaemon(process.execPath, scriptPath, [DAEMON_INNER_COMMAND, PORT_FLAG, String(port)], port);
  await waitForDaemon(port);
}
