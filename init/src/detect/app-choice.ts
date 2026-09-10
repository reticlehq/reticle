/**
 * Which app in a workspace `reticle init` should wire, when the caller says.
 *
 * Refusing to guess between several apps is right — instrumenting one silently would leave the rest
 * unverified while reporting success. But "re-run inside the one you want" is not an answer a
 * script, a CI step, or an agent that cannot change directory can act on, so the refusal was a dead
 * end for exactly the callers most likely to hit it.
 *
 * A name that is not one of the discovered apps is refused rather than trusted: it is almost always
 * a typo or a stale path, and wiring a directory that is not an app writes files nothing compiles.
 */

type AppChoice = { ok: true; app: string | undefined } | { ok: false; message: string };

export function chooseWorkspaceApp(
  requested: string | undefined,
  apps: readonly string[],
): AppChoice {
  if (requested === undefined || '' === requested) return { ok: true, app: undefined };
  // Tab-completion adds a trailing slash; the discovered names never carry one.
  const wanted = requested.replace(/\/+$/, '');
  if (apps.includes(wanted)) return { ok: true, app: wanted };
  return {
    ok: false,
    message:
      0 === apps.length
        ? `--app ${requested} was given, but no app was found in this workspace`
        : `--app ${requested} is not one of the apps found here: ${apps.join(', ')}`,
  };
}
