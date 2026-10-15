/**
 * An ADVISORY marker that a run looks automated, for the runs `ci` cannot see.
 *
 * `ci` is a single environment variable, which is exactly right for a GitHub Actions runner and
 * blind to everything else: our own gate has run from a datacenter and landed in the user data
 * indistinguishable from somebody at a laptop.
 *
 * ADVISORY, and never a filter. A real person works inside a container, inside a Codespace, and over
 * an ssh session with no terminal attached, and every one of them is a user. Nothing may drop a row
 * because this is set; it exists so a surprising number can be looked at from a second angle, and a
 * hint that starts being used as an exclusion has stopped being a hint. Absent means "nothing here
 * looked automated", never "a human was present".
 *
 * WHAT WAS REJECTED, so nobody re-proposes it:
 *  - IP address, ASN or datacenter geolocation. Not knowable client-side, and it is a stronger
 *    identifier than anything else we collect. The one signal that would actually separate a cloud
 *    sandbox from a laptop is the one we will not collect.
 *  - Hostname patterns (`runner-*`, `ip-10-*`). A hostname is user data, and matching names is
 *    guesswork dressed as a measurement — a guessed dimension and a measured one are
 *    indistinguishable once they are in the same column.
 *  - Process ancestry. Costs a spawn on a path that must never tax a command, and reads the name of
 *    somebody else's program to classify our own user.
 *  - `npm_config_user_agent`. Says which package manager ran us, which every route shares.
 *  - An absent `$DISPLAY`. Every Linux server, every ssh session, and a large share of genuine
 *    developer machines trip it; it separates nothing.
 *  - No terminal on stdin/stdout. It was the third signal here, and every MCP stdio server has no
 *    terminal, so it fired on nearly every daemon a person's agent started and separated nothing.
 */
import { existsSync } from 'node:fs';
import { AutomationHint } from '@reticlehq/core/telemetry';

/** Container runtimes drop one of these at the filesystem root. */
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'] as const;

/** Hosted dev environments that declare themselves. Self-declared, never inferred. */
const HOSTED_WORKSPACE_ENV = [
  'CODESPACES',
  'GITPOD_WORKSPACE_ID',
  'CLOUD_SHELL',
  'REMOTE_CONTAINERS',
] as const;

/**
 * CI vendors' own variables, for the runners and self-hosted agents that do not set `CI`. Each is
 * set by the runner itself; a person's shell does not carry them.
 */
const CI_VENDOR_ENV = [
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'JENKINS_URL',
  'TF_BUILD',
  'TEAMCITY_VERSION',
  'BITBUCKET_BUILD_NUMBER',
  'CODEBUILD_BUILD_ID',
  'DRONE',
  'TRAVIS',
] as const;

/**
 * Hosted coding-agent sandboxes that declare themselves to what they spawn. Only markers the agent
 * sets on purpose for a REMOTE session: a local agent's own marker (`CLAUDECODE`) is a person at a
 * laptop and belongs to `client`, not here.
 */
const AGENT_SANDBOX_ENV = ['CLAUDE_CODE_REMOTE'] as const;

interface AutomationInput {
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
}

const declared = (env: NodeJS.ProcessEnv, keys: readonly string[]): boolean =>
  keys.some((k) => (env[k] ?? '') !== '' && 'false' !== env[k]);

/**
 * The most specific signal that fires, or undefined.
 *
 * Ordered most specific first: an agent sandbox runs in a container, and a container inside a
 * Codespace is one fact about the run; sending the weaker signal would waste the field. Omitted rather than sent as a
 * "none" value, so its presence is itself the signal — the convention every other advisory field
 * here follows.
 */
export function resolveAutomationHint(input: AutomationInput): AutomationHint | undefined {
  if (declared(input.env, AGENT_SANDBOX_ENV)) return AutomationHint.AGENT_SANDBOX;
  if (declared(input.env, CI_VENDOR_ENV)) return AutomationHint.CI_RUNNER;
  if (CONTAINER_MARKERS.some((m) => input.fileExists(m))) return AutomationHint.CONTAINER;
  if (declared(input.env, HOSTED_WORKSPACE_ENV)) return AutomationHint.HOSTED_WORKSPACE;
  return undefined;
}

/**
 * A CI runner: `CI` itself or a vendor's own variable. The one place a command line decides whether
 * it is a pipeline or a person, so a run is credited to somebody whenever nothing says CI.
 */
export function isCiEnv(env: NodeJS.ProcessEnv): boolean {
  return declared(env, ['CI', ...CI_VENDOR_ENV]);
}

/** The real reading, taken once per process. */
export function currentAutomationHint(env: NodeJS.ProcessEnv): AutomationHint | undefined {
  return resolveAutomationHint({
    env,
    fileExists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false; // an unreadable root is not evidence of anything
      }
    },
  });
}
