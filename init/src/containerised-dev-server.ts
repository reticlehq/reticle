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
 * DETECTION IS DELIBERATELY CHEAP AND OVER-EAGER. A Dockerfile or a compose file near the app is not
 * proof the dev server runs in one — plenty of repos containerise only production. But this step
 * asks for nothing and changes nothing, so a false positive costs one paragraph the reader skips,
 * while a false negative costs what it cost in the field.
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
