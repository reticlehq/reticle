import {
  McpClient,
  MCP_CLIENTS,
  claudeAddCommand,
  claudeAvailableProbe,
  claudeHasReticle,
  codexAddCommand,
  codexAvailableProbe,
  codexNamesOurServer,
  detectMcpClients,
  mergeClientConfig,
  clientSpec,
  ClientMergeStatus,
  type DetectedClient,
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
  /** Automatic registration was attempted but failed. */
  readonly failed: readonly string[];
  /**
   * Clients whose config this will NOT rewrite, and which therefore still need a human.
   *
   * Separate from `registered` because it used to be inside it. `mergeClientConfig` answers MANUAL
   * for a format we decline to rewrite, and documents its `content` as byte-identical to the
   * existing file in that case, so writing it is a no-op when the file exists and creates an EMPTY
   * one when it does not. The loop below handled ALREADY and treated everything else as applied, so
   * Codex CLI was reported `registered` while its `config.toml` gained nothing: a false success in
   * the install path, and the user got no tools and no snippet either. Reproduced with an empty HOME
   * and a pre-seeded `~/.codex/config.toml`; the file came back byte-identical both times.
   */
  readonly manual: readonly ManualClient[];
}

/** A client the caller has to tell somebody about, with the two facts they need to act. */
export interface ManualClient {
  readonly id: string;
  readonly configPath: string;
  readonly docs: string | undefined;
}

/**
 * Codex registers through `codex mcp add`, which does the TOML editing we refuse to do (#1238).
 * `undefined` when that does not apply, and the caller reports a hand edit exactly as before: not
 * Codex, the `codex` binary is not here, or the config already names a `reticle` server. That last
 * one matters: `codex mcp add` REPLACES an entry of the same name and still exits 0, so an entry
 * somebody wrote themselves, in any shape, must never reach it. Otherwise: did the command take.
 */
function registerWithCodexCli(
  io: SetupMcpIo,
  client: DetectedClient,
  serversKey: string,
): boolean | undefined {
  if (McpClient.CODEX !== client.id || codexNamesOurServer(client.existing, serversKey)) {
    return undefined;
  }
  const probe = codexAvailableProbe();
  if (!io.runCli(probe.command, probe.args)) return undefined;
  const cmd = codexAddCommand();
  return io.runCli(cmd.command, cmd.args);
}

export function setupMcp(io: SetupMcpIo): SetupMcpResult {
  const detected: string[] = [];
  const registered: string[] = [];
  const alreadyThere: string[] = [];
  const failed: string[] = [];
  const manual: ManualClient[] = [];

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
    // Read from Claude's config: `claude mcp get` health-checks by launching the server.
    if (claudeHasReticle(io, undefined)) {
      alreadyThere.push(McpClient.CLAUDE_CODE);
    } else {
      const cmd = claudeAddCommand();
      if (io.runCli(cmd.command, cmd.args)) registered.push(McpClient.CLAUDE_CODE);
      else failed.push(McpClient.CLAUDE_CODE);
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
    // A format we decline to rewrite is not a registration. Writing `content` here would be a no-op
    // on an existing file and would CREATE an empty one otherwise, and either way claiming success
    // sends somebody to an agent that has no Reticle tools in it.
    if (ClientMergeStatus.MANUAL === merged.status) {
      const viaCli = registerWithCodexCli(io, client, spec.serversKey);
      if (true === viaCli) registered.push(client.id);
      else if (false === viaCli) failed.push(client.id);
      else manual.push({ id: client.id, configPath: client.configPath, docs: spec.docs });
      continue;
    }
    try {
      io.writeFile(client.configPath, merged.content);
      registered.push(client.id);
    } catch {
      failed.push(client.id);
    }
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
    /*
     * SKIPPED when there was nothing to register with — not failed. Nothing went wrong; there was
     * simply no agent here, and counting that as our failure would hide the ones that are.
     *
     * FAILED when no detected client is usable, whether registration failed or needs a hand.
     * That case used to fall through to COMPLETED,
     * so the cohort with the tools registered NOWHERE was counted among the successful installs, and
     * the one number that says "did this machine get Reticle" read yes for the people it read no
     * for. Registering some and not others is still COMPLETED: the agent they are using may well be
     * one that worked, and a partial win is not a failed step.
     */
    status:
      0 === detected.length
        ? OnboardingStepStatus.SKIPPED
        : 0 === registered.length && alreadyThere.length > 0
          ? OnboardingStepStatus.SKIPPED
          : 0 === registered.length && 0 === alreadyThere.length
            ? OnboardingStepStatus.FAILED
            : OnboardingStepStatus.COMPLETED,
  });

  return { detected, registered, alreadyThere, failed, manual };
}

/** Everything this machine could be asked about, for the report when nothing was found. */
export function knownClientLabels(): string[] {
  return MCP_CLIENTS.map((c) => c.label);
}

export { McpClient };
