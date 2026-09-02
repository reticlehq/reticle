/**
 * Which app in a workspace `reticle init` should wire, when the caller says.
 *
 * Refusing to guess between several apps is right — instrumenting one silently would leave the rest
 * unverified while reporting success. But "re-run inside the one you want" is not an answer a
 * script, a CI step, or an agent that cannot change directory can act on, so the refusal was a dead
 * end for exactly the callers most likely to hit it.
 *
 * A name that is not one of the discovered apps is not automatically trusted either — but discovery
 * can miss a real app (a declared workspace that does not cover it, a directory two levels under a
 * parent nothing walks that deep into, #682), and refusing `--app` for the same reason left no way
 * in at all. `hasManifest` is the caller's answer to "does this path have its own package.json?" —
 * when it does, an explicit `--app` is an instruction, not a suggestion, and settles it regardless of
 * what discovery found. Left unset, an unknown name is still refused, matching the old behaviour.
 */

type AppChoice = { ok: true; app: string | undefined } | { ok: false; message: string };

export function chooseWorkspaceApp(
  requested: string | undefined,
  apps: readonly string[],
  hasManifest?: (dir: string) => boolean,
): AppChoice {
  if (requested === undefined || '' === requested) return { ok: true, app: undefined };
  // Tab-completion adds a trailing slash; the discovered names never carry one.
  const wanted = requested.replace(/\/+$/, '');
  if (apps.includes(wanted)) return { ok: true, app: wanted };
  if (true === hasManifest?.(wanted)) return { ok: true, app: wanted };
  return {
    ok: false,
    message:
      0 === apps.length
        ? `--app ${requested} was given, but no app was found in this workspace`
        : `--app ${requested} is not one of the apps found here: ${apps.join(', ')}`,
  };
}
