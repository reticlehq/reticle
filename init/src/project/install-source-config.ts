/**
 * The same `.reticle.json` with `installSource` added, or `undefined` when there is nothing to add.
 *
 * `installSource` is written only when `.reticle.json` is CREATED, and `init` reports that file as
 * `already exists` on every re-run — so a project that already had one keeps `unknown`.
 *
 * An EXISTING value is never overwritten. Anything unparseable is left exactly as it is: a config is
 * user data, and `init` rewriting a file it could not read is worse than a missing field.
 *
 * Lives here because `init` is the only thing that writes this file. Deciding WHICH channel declared
 * itself stays in the server's `telemetry/install-source.ts`, which re-exports this for its own
 * tests; the value arrives as `PlanInput.installSource`.
 */
export function configWithInstallSource(
  source: string | null | undefined,
  declared: string | undefined,
): string | undefined {
  if (undefined === declared || null === source || undefined === source) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (null === parsed || 'object' !== typeof parsed || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (undefined !== fields['installSource']) return undefined;
  return `${JSON.stringify({ ...fields, installSource: declared }, null, 2)}\n`;
}
