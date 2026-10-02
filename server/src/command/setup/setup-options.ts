/**
 * The contract between the agent and the script.
 *
 * Everything setup does is deterministic except for the handful of things that require reading a
 * repository and a human's request and understanding both. Those are exactly what an agent is good
 * at and code is not, so they arrive here as ARGUMENTS rather than as steps somebody walks through:
 * the agent decides, the script executes, and neither does the other's job.
 *
 * What only an agent can know, and therefore what belongs in this type:
 *
 *   --app       which app in a monorepo the user meant. init can find the ones that are servable;
 *               only the request says which of them is being worked on.
 *   --env       what the app needs to get past its own front door. A key in .env.example, a mock
 *               backend named in the README, the variable that skips an auth wall: all readable by
 *               an agent, none inferable by a script. Without this a real app sits on a login
 *               screen and there is no flow to drive at all.
 *   --url       the app is already running here, so do not start anything. This is also the answer
 *               when the project's own scripts do not name a dev command: start it yourself and say
 *               where. There is no flag that overrides the dev command; --url replaces the need.
 *
 * Everything else on this type is an operator's dial, not an agent's judgement.
 *
 * `--flow` used to head that list -- which journey to prove. Onboarding stopped driving in 7e698fea
 * and the flag was retired with it, so naming the journey belongs to the FIRST RUN now
 * (`reticle_verify { action: "explore", persona: ... }`), not to this type.
 */

/** The bridge port. NOT the dev server's, and conflating them is a documented setup failure. */
export const DEFAULT_BRIDGE_PORT = 4400;
/** Per-phase budget. */
export const DEFAULT_PHASE_TIMEOUT_MS = 120_000;

interface SetupOptions {
  // ── what only an agent can know ────────────────────────────────────────────────────────────────
  /** Which app in a monorepo. */
  readonly app?: string | undefined;
  /** Environment the app needs in order to reach a usable state. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** The dev command, when the project's scripts do not say it plainly. */
  readonly devCommand?: string | undefined;
  /** The app is already served here. */
  readonly url?: string | undefined;

  // ── operator dials ────────────────────────────────────────────────────────────────────────────
  readonly bridgePort: number;
  readonly phaseTimeoutMs: number;
  /** Register the MCP with the other coding agents on this machine. */
  readonly registerAgents: boolean;
  /** Open a browser. False for CI, a headless box, or a tab the user already has. */
  readonly openBrowser: boolean;
  /** Restart a dev server whose bundle predates the build-config edit. */
  readonly restartStaleDevServer: boolean;
  /** Write files and stop, which is what `init` did before it grew the runtime phases. */
  readonly filesOnly: boolean;
  /** A license key, written to .env and never echoed. */
  readonly licenseKey?: string | undefined;
}

export const DEFAULT_SETUP_OPTIONS: SetupOptions = {
  bridgePort: DEFAULT_BRIDGE_PORT,
  phaseTimeoutMs: DEFAULT_PHASE_TIMEOUT_MS,
  registerAgents: true,
  openBrowser: true,
  restartStaleDevServer: true,
  filesOnly: false,
};

/** One `KEY=VALUE`, as an agent would pass it. Everything after the first `=` is the value. */
export function parseEnvAssignment(pair: string): { key: string; value: string } | null {
  const at = pair.indexOf('=');
  if (0 >= at) return null;
  const key = pair.slice(0, at).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, value: pair.slice(at + 1) };
}

/**
 * Fold repeated `--env KEY=VALUE` into one map, ignoring what cannot be a variable.
 *
 * A malformed pair is dropped rather than guessed at: an agent that meant `--env` and typed
 * something else should see its variable missing, not see setup invent one.
 */
export function collectEnv(pairs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const parsed = parseEnvAssignment(pair);
    if (null !== parsed) env[parsed.key] = parsed.value;
  }
  return env;
}
