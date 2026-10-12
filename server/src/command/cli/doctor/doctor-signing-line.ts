/**
 * Whether macOS will ask for the keychain password every time the app Reticle drives reads it.
 *
 * Reported from the field: a signed macOS Tauri app driven by Reticle flooded its user with password
 * dialogs. Reticle never touches the keychain; macOS binds each keychain item to the signature of
 * the app that saved it, and the build Reticle runs (`tauri dev`, ad-hoc signed) is another app to
 * the keychain. Read from `codesign -dv`, through an injected runner, so the parsing is a unit test.
 */

/** What `codesign -dv` says about one binary. */
export interface Signature {
  /** Ad-hoc signed, or not signed at all: no identity the keychain can recognise. */
  adhoc: boolean;
  identifier?: string;
  teamId?: string;
}

export const KEYCHAIN_NOTE =
  "macOS ties keychain items to the app's signature; this build is signed differently, so the " +
  "app's keychain reads will ask for your password. Sign this build with your release identity " +
  '(APPLE_SIGNING_IDENTITY / signingIdentity) or use a separate keychain service in dev.';

const NOT_SIGNED = 'code object is not signed at all';
const NO_TEAM = 'not set';

/** `codesign -dv` output (it writes to stderr), or undefined when it said nothing usable. */
export function parseCodesign(output: string): Signature | undefined {
  if (output.includes(NOT_SIGNED)) return { adhoc: true };
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}=(.+)$`, 'm').exec(output)?.[1]?.trim();
  const identifier = field('Identifier');
  if (identifier === undefined) return undefined;
  const team = field('TeamIdentifier');
  return {
    adhoc: 'adhoc' === field('Signature'),
    identifier,
    ...(team === undefined || NO_TEAM === team ? {} : { teamId: team }),
  };
}

/** The note, when the build is unsigned, ad-hoc, or signed by another team than the installed app. */
export function signingNote(
  build: Signature | undefined,
  installed: Signature | undefined,
): string | undefined {
  if (build === undefined) return undefined;
  if (build.adhoc) return KEYCHAIN_NOTE;
  if (installed !== undefined && installed.teamId !== build.teamId) return KEYCHAIN_NOTE;
  return undefined;
}

/** The dev binary `tauri dev` runs, and where an installed copy of the same app would be. */
export function tauriDevBinary(
  read: (path: string) => string | undefined,
): { build: string; installed?: string } | undefined {
  const cargo = read('src-tauri/Cargo.toml');
  const name = cargo === undefined ? undefined : /^name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  if (name === undefined) return undefined;
  let product: unknown;
  try {
    product = (JSON.parse(read('src-tauri/tauri.conf.json') ?? '{}') as Record<string, unknown>)[
      'productName'
    ];
  } catch {
    product = undefined;
  }
  return {
    build: `src-tauri/target/debug/${name}`,
    ...('string' === typeof product && 0 < product.length
      ? { installed: `/Applications/${product}.app` }
      : {}),
  };
}
