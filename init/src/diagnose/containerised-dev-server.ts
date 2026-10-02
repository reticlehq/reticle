/**
 * The install shape Reticle assumes, stated once, for the projects that do not have it.
 *
 * Everything in `init` assumes the CLI and the dev server share a filesystem: the daemon writes
 * `~/.reticle/pairing-token`, the build plugin reads it at config time and inlines it into the page,
 * and the bridge checks that they match. When the dev server runs in a container that assumption is
 * silently false — `$HOME` in there is the image's throwaway root, so the plugin finds no token,
 * mints its own, and every page it serves is refused with `authentication failed`.
 *
 * Measured in the field: six minutes to diagnose, ending in a grep through the plugin's shipped
 * `dist/` inside the container for an environment variable that appeared in no documentation. The
 * daemon now says all this when it happens (see no-session-next-action). This says it BEFORE it
 * happens, which is the difference between a note and a debugging session.
 *
 * It also names the rebuild. A containerised dev server usually installs its own `node_modules` into
 * an anonymous volume, so `init` adding two dependencies is not picked up by restarting the
 * container — it needs an image rebuild and a fresh volume. The same field install lost two and a
 * half minutes discovering that through a failed build.
 *
 * DETECTION IS CHEAP, AND ERRS TOWARDS SPEAKING — but a container file counts only when it RUNS a
 * dev server (see runsDevServer). It used to count on presence alone, and React Router's own
 * template ships a production Dockerfile, so every React Router install was told to rebuild an image
 * and mount a token for a dev server that runs on the host. A devcontainer still counts on presence:
 * it is the development environment by definition.
 */

import { ReticleEnv } from '@reticlehq/core';

/** Files whose presence means this repo builds a container image somewhere near the app. */
export const CONTAINER_MARKERS = [
  'Dockerfile',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.devcontainer/devcontainer.json',
] as const;

export const CONTAINERISED_TITLE = 'Containerised dev server';

/**
 * The note itself. Both halves are things that go wrong at the same moment and look identical from
 * the page — the SDK loads, the socket opens, no session appears — so they are told together.
 */
export function containerisedDevServerNote(marker: string): string {
  return (
    `this project has a \`${marker}\`, so IF your dev server runs in a container two things about ` +
    'this install are different, and both of them end in "no session" with nothing looking broken.\n' +
    '  1. DEPENDENCIES. A container that installs its own node_modules will not see the two packages ' +
    'added here by restarting — rebuild the image and renew the volume ' +
    '(`docker compose build <service> && docker compose up -d --renew-anon-volumes <service>`).\n' +
    '  2. THE PAIRING TOKEN. The daemon writes `~/.reticle/pairing-token` on the HOST; the build ' +
    'plugin reads it from `$HOME` INSIDE the container, does not find it, and mints a different one — ' +
    'which the bridge then refuses. Mount the host file read-only and point the plugin at it:\n' +
    '       environment:\n' +
    `         ${ReticleEnv.PAIRING_TOKEN_DIR}: /reticle-state\n` +
    '       volumes:\n' +
    '         - ~/.reticle/pairing-token:/reticle-state/pairing-token:ro\n' +
    '     The token is inlined when the dev server resolves its config, so restart it afterwards. ' +
    'Run the Reticle daemon at least once first, or Docker creates a DIRECTORY at that host path.'
  );
}

const DEVCONTAINER = '.devcontainer/devcontainer.json';

/**
 * Commands that start a dev server, in shell form or Dockerfile exec form (`["npm", "run", "dev"]`).
 * The separator class takes quotes and commas so both spellings match. `vite` counts bare, or
 * followed by a flag, but never as `vite build` / `vite preview`, which serve nothing live.
 */
const SEP = `["',\\s]+`;
const DEV_SERVER_COMMANDS: readonly RegExp[] = [
  new RegExp(`\\b(?:npm|pnpm|yarn|bun)${SEP}(?:run${SEP})?dev\\b`),
  new RegExp(`\\b(?:next|nuxt|nuxi|astro|react-router|remix|vinxi)${SEP}dev\\b`),
  new RegExp(`\\bng${SEP}serve\\b`),
  new RegExp(`\\breact-scripts${SEP}start\\b`),
  new RegExp(`\\bwebpack${SEP}serve\\b|\\bwebpack-dev-server\\b`),
  /\bvite["']?(?=\s*(?:$|--|["']?\s*[\],]))/m,
];

/**
 * Does this container file run the app's dev server?
 *
 * @param devScript the app's own `scripts.dev`, so a container that runs it by its command rather
 *   than through the package manager (`CMD react-router dev`) still counts.
 */
export function runsDevServer(
  marker: string,
  content: string,
  devScript: string | undefined,
): boolean {
  if (DEVCONTAINER === marker) return true;
  if (
    devScript !== undefined &&
    0 < devScript.trim().length &&
    content.includes(devScript.trim())
  ) {
    return true;
  }
  return DEV_SERVER_COMMANDS.some((command) => command.test(content));
}
