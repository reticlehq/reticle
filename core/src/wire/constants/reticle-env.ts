/**
 * Every environment variable Reticle reads, named once. A misspelled inline env string silently
 * disables the control it gates (e.g. a typo'd `RETICLE_TOKEN` would disable auth) — so the names live
 * here and nowhere else. The values are the literal process.env keys.
 */
export const ReticleEnv = {
  /** "0"/"false"/"off" turns off telemetry and every optional outbound call; DO_NOT_TRACK too. */
  TELEMETRY: 'RETICLE_TELEMETRY',
  DO_NOT_TRACK: 'DO_NOT_TRACK',
  /** Shared-secret the browser SDK must present in HELLO; absent ⇒ loopback-trust only. */
  TOKEN: 'RETICLE_TOKEN',
  /** Bridge bind host. Defaults to loopback; setting anything else is opt-in remote exposure. */
  HOST: 'RETICLE_HOST',
  /** Comma-separated WS Origin allow-list for the bridge. */
  ALLOWED_ORIGINS: 'RETICLE_ALLOWED_ORIGINS',
  /** Bridge/daemon WS port override. */
  PORT: 'RETICLE_PORT',
  /** Daemon state — pidfiles, discovery registry, logs. Defaults to `~/.reticle`. Overridable
   * because a read-only $HOME (sandboxed agent, locked-down Windows profile, container) otherwise
   * makes the daemon unstartable with a raw EACCES naming nothing. Reported by a Windows user. */
  STATE_DIR: 'RETICLE_STATE_DIR',
  /** Attach to an already-running browser over CDP instead of launching one. */
  CDP_URL: 'RETICLE_CDP_URL',
  /** The Chromium executable to launch, in place of Playwright's own build or an installed Chrome. */
  CHROMIUM_PATH: 'RETICLE_CHROMIUM_PATH',
  /** Max simultaneous leased headless contexts in the browser pool (resource cap). */
  MAX_CONTEXTS: 'RETICLE_MAX_CONTEXTS',
  /**
   * Inbound events per second before the bridge starts SAMPLING (never disconnecting).
   *
   * Raise it for a legitimately busy app — a streaming dashboard, a live grid — rather than accept
   * partial coverage. Free and local: the daemon runs on the same machine, so a higher ceiling costs
   * nothing to anyone.
   */
  MAX_MESSAGES_PER_SECOND: 'RETICLE_MAX_MESSAGES_PER_SECOND',
  /** Bearer token required by the optional `reticle serve --http` verify endpoint. */
  VERIFY_TOKEN: 'RETICLE_VERIFY_TOKEN',
  /** Ms of continuous idleness (no agent, no browser session, no lease) before the daemon self-exits;
   * `0` disables. Keeps Reticle from lingering on a user's machine after the editor closes. */
  IDLE_SHUTDOWN: 'RETICLE_IDLE_SHUTDOWN_MS',
  /** Idle re-check cadence (default 30s). Overridable so daemon-lifecycle-test can watch a full
   * exit/wake cycle in seconds rather than minutes. */
  IDLE_CHECK: 'RETICLE_IDLE_CHECK_MS',
  /**
   * Grace for a daemon with an agent ATTACHED. Longer than the base on purpose: quiet with a client
   * present means a slow install or a thinking human, not an unwanted daemon — a flat 5 minutes was
   * killing live runs mid-install. Derived from the base when unset.
   */
  IDLE_ATTACHED: 'RETICLE_IDLE_ATTACHED_MS',
  /**
   * How often the daemon writes `reticle_daemon_alive`, so a GAP in its log is evidence it died.
   *
   * Overridable for the same reason the idle windows are: a spec that has to prove "a killed daemon
   * is distinguishable from a tidy one" cannot wait 30 seconds per beat, and a spec that instead
   * re-implements the cadence is insensitive to the thing it claims to guard.
   */
  HEARTBEAT: 'RETICLE_HEARTBEAT_MS',
  /** Directory holding the auto-provisioned pairing token. Defaults to ~/.reticle; relocatable for CI. */
  PAIRING_TOKEN_DIR: 'RETICLE_PAIRING_TOKEN_DIR',
  /** Force the durable causal journal off (`0`/`false`/`off`) or on (`1`/`true`/`on`); default on. */
  JOURNAL: 'RETICLE_JOURNAL',
  /**
   * Verbose internal flow tracing for people working ON Reticle (`1`/`true`/`on`); default off.
   *
   * Distinct from the journal, which records what the AGENT did to the app. This records what
   * RETICLE did to answer it: one line per internal stage, with its duration and nesting, so a
   * developer can see which code a tool call actually went through and where the time went.
   * Off by default and free when off — a trace on every tool call is a cost on the hot path.
   */
  TRACE: 'RETICLE_TRACE',
  /**
   * How many consecutive reconnects the MCP proxy attempts before it stops retrying and goes
   * dormant. Overridable for the same reason the idle windows are: the real budget takes MINUTES to
   * exhaust, so the one spec that proves the proxy SURVIVES exhaustion could not run at all without
   * shortening it. A budget nobody can reach in a test is a budget nobody tests.
   */
  RECONNECT_ATTEMPTS: 'RETICLE_RECONNECT_ATTEMPTS',
  /** Quiet window before an abandoned MCP stdio proxy exits; `0` disables the watcher. */
  MCP_PROXY_IDLE: 'RETICLE_MCP_PROXY_IDLE_MS',
  /**
   * API key for the harness — the model that drives the app when no coding agent is in the loop.
   *
   * The standard Anthropic name, on purpose: a machine that can already run a coding agent can
   * already run the harness, with nothing to configure. Absent ⇒ the harness is simply unavailable
   * and every other part of Reticle is unaffected.
   */
  HARNESS_KEY: 'ANTHROPIC_API_KEY',
  /** Model the harness drives with. Defaults to a small one — see `DEFAULT_HARNESS_MODEL`. */
  HARNESS_MODEL: 'RETICLE_HARNESS_MODEL',
  /** Base URL for the harness's model API, for a proxy or a gateway. */
  HARNESS_BASE_URL: 'RETICLE_HARNESS_BASE_URL',
  /** Hard ceiling on harness model turns in one drive. Bounds cost, not value. */
  HARNESS_MAX_STEPS: 'RETICLE_HARNESS_MAX_STEPS',
  /** The free drive `reticle try` was granted, sent on every Harness call it bills. */
  DRIVE_ID: 'RETICLE_DRIVE_ID',
  /**
   * Which model backs the harness driver: `anthropic` (the default) or `jev`.
   *
   * Two drivers exist because the driver's job turns out not to need a text generator. It picks the
   * next action and says what it expects; the verdict is decided afterwards by the engine, with no
   * model anywhere near it. A System One model answers typed questions against a state, which is
   * exactly that job and none of the rest, so it can drive without being able to generate a
   * sentence. Unset keeps the existing behaviour for everybody who has not asked for this.
   */
  HARNESS_DRIVER: 'RETICLE_HARNESS_DRIVER',
  /**
   * A direct Jev key, for this repo's own benchmarks and for anyone holding a TypeSafe account.
   *
   * Users are not expected to have one. The ordinary path is the key they already minted on the
   * platform (`RETICLE_API_KEY`), which reaches Jev through the proxy at `RETICLE_CLOUD_URL` —
   * this variable is the escape hatch that skips it, and it takes precedence when both are set so
   * that a developer debugging the upstream is never silently talking to the proxy instead.
   */
  HARNESS_JEV_KEY: 'JEV_API_KEY',
  /** Base URL for the Jev API, for a proxy or a gateway. Defaults to TypeSafe's own endpoint. */
  HARNESS_JEV_URL: 'RETICLE_HARNESS_JEV_URL',
  /** A direct OpenAI key. As with Jev, the ordinary path is the platform key and its proxy. */
  HARNESS_OPENAI_KEY: 'OPENAI_API_KEY',
  /** Model the OpenAI driver uses. Defaults to a small one — see `DEFAULT_OPENAI_MODEL`. */
  HARNESS_OPENAI_MODEL: 'RETICLE_HARNESS_OPENAI_MODEL',
  /**
   * The API key minted on the platform, and the host it belongs to.
   *
   * Read through `apiKeyFrom()`, never directly — see the note on that function for why there are
   * two names for one key and why neither may be dropped.
   */
  API_KEY: 'RETICLE_API_KEY',
  /** The name this key had until 2026-09. Still honoured; see `apiKeyFrom()`. */
  CLOUD_KEY: 'RETICLE_CLOUD_KEY',
  /** The platform host. Read through `cloudUrlFrom()`, which also accepts `URL`. */
  CLOUD_URL: 'RETICLE_CLOUD_URL',
  /** The short name for `CLOUD_URL`, which people type first. `CLOUD_URL` wins when both are set. */
  URL: 'RETICLE_URL',
  /** "0"/"false"/"off" stops `reticle hook prompt` writing prompts, on this whole machine. */
  PROMPT_CAPTURE: 'RETICLE_PROMPT_CAPTURE',
  /** "0"/"false"/"off" stops the daemon's background sync, on this whole machine. */
  BACKGROUND_SYNC: 'RETICLE_BACKGROUND_SYNC',
  /** Set by the parent that starts the daemon: how it started it. A `DaemonSpawnMethod`. */
  SPAWN_METHOD: 'RETICLE_SPAWN_METHOD',
} as const;
