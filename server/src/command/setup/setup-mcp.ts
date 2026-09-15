import {
  McpClient,
  MCP_CLIENTS,
  claudeAddCommand,
  claudeAvailableProbe,
  claudeExistsProbe,
  detectMcpClients,
  mergeClientConfig,
  clientSpec,
  ClientMergeStatus,
} from '@reticlehq/init';
import {
  OnboardingPhase,
  OnboardingStepStatus,
  type OnboardingStep,
} from '@reticlehq/core/telemetry';

/**
 * `reticle setup mcp` — register the MCP server with every coding agent on this machine.
 *
 * `init` wires one PROJECT. This registers the server for the USER, which is a different job and
 * the one the installer needs: at install time there is no project yet, and telling somebody to go
 * and find one before their agent has any tools is how a two-minute setup becomes an afternoon.
 *
 * It writes only into configs an agent ALREADY keeps — see `detectMcpClients` for why. Creating
 * `~/.gemini` for somebody who does not use Gemini is not helpfulness, it is litter in a home
 * directory, and it makes the next tool's detection wrong too.
 */
export interface SetupMcpIo {
  exists(path: string): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, contents: string): void;
  homeDir(): string;
  print(line: string): void;
  /** Register with a client that owns its own registration (Claude Code). Returns whether it took. */
  runCli(command: string, args: readonly string[]): boolean;
  /**
   * Report one funnel step. INJECTED, not imported.
   *
   * This directory decides what to register and where; it does not own a telemetry client. The
   * reach guard refused the import and its advice was right — the same inversion teardown already
   * uses, and it keeps this function testable without a wire.
   */
  reportStep(step: OnboardingStep): void;
}

export interface SetupMcpResult {
  readonly detected: readonly string[];
  readonly registered: readonly string[];
  readonly alreadyThere: readonly string[];
}

export function setupMcp(io: SetupMcpIo): SetupMcpResult {
  const detected: string[] = [];
  const registered: string[] = [];
  const alreadyThere: string[] = [];

  /*
   * Claude Code first, because nothing else can find it.
   *
   * `detectMcpClients` reads config files and Claude Code keeps none — it owns its registration
   * behind `claude mcp add`, which is why its spec is `ConfigScope.CLI`. `fileBackedClients()`
   * filters CLI scope out by construction, so this used to be a `ConfigScope.CLI` branch INSIDE
   * the loop below, over a list that can never contain a CLI client. It was unreachable, and the
   * effect was that the one-line installer told anybody running Reticle's most common client
   * "No coding agent config found" and left their agent with no tools.
   *
   * Its own CLI is the probe, and it is the honest one: a config file only says the client was
   * installed once, while `claude --version` says it is here now. Absent, this registers nothing
   * and claims nothing — the negative control in the test file.
   */
  const available = claudeAvailableProbe();
  if (io.runCli(available.command, available.args)) {
    detected.push(McpClient.CLAUDE_CODE);
    const already = claudeExistsProbe();
    if (io.runCli(already.command, already.args)) {
      alreadyThere.push(McpClient.CLAUDE_CODE);
    } else {
      const cmd = claudeAddCommand();
      if (io.runCli(cmd.command, cmd.args)) registered.push(McpClient.CLAUDE_CODE);
    }
  }

  for (const client of detectMcpClients(io)) {
    detected.push(client.id);
    const spec = clientSpec(client.id);
    const merged = mergeClientConfig(spec, client.existing);
    if (ClientMergeStatus.ALREADY === merged.status) {
      alreadyThere.push(client.id);
      continue;
    }
    io.writeFile(client.configPath, merged.content);
    registered.push(client.id);
  }

  /*
   * Both INSTALL steps, reported from the one place that knows the answer.
   *
   * `agents_detected` is COMPLETED even when the count is zero, and that is the point: "this
   * machine has no coding agent we recognise" is a real and important answer, not a failure. A
   * funnel that only records successful detections cannot show the agents Reticle does not serve.
   */
  io.reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'agents_detected',
    status: OnboardingStepStatus.COMPLETED,
  });
  io.reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'mcp_registered',
    // SKIPPED when there was nothing to register with — not failed. Nothing went wrong; there was
    // simply no agent here, and counting that as our failure would hide the ones that are.
    status:
      0 === detected.length
        ? OnboardingStepStatus.SKIPPED
        : 0 === registered.length && alreadyThere.length > 0
          ? OnboardingStepStatus.SKIPPED
          : OnboardingStepStatus.COMPLETED,
  });

  return { detected, registered, alreadyThere };
}

/** Everything this machine could be asked about, for the report when nothing was found. */
export function knownClientLabels(): string[] {
  return MCP_CLIENTS.map((c) => c.label);
}

export { McpClient };
