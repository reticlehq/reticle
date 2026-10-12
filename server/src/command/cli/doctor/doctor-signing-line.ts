/**
 * Whether macOS will ask for the keychain password every time the app Reticle drives reads it.
 *
 * Reported from the field: a signed macOS Tauri app driven by Reticle flooded its user with password
 * dialogs. Reticle never touches the keychain; macOS binds each keychain item to the signature of
 * the app that saved it, and the build Reticle runs (`tauri dev`, ad-hoc signed) is another app to
 * the keychain. Read from `codesign -dv`, through an injected runner, so the parsing is a unit test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, posix } from 'node:path';

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

/**
 * The dev binary `tauri dev` runs, the release builds `tauri build` leaves (the bundle first), and
 * where an installed copy of the same app would be.
 */
export function tauriDevBinary(
  read: (path: string) => string | undefined,
): { build: string; release: string[]; installed?: string } | undefined {
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
  const named = 'string' === typeof product && 0 < product.length ? product : undefined;
  return {
    build: `src-tauri/target/debug/${name}`,
    release: [
      ...(named === undefined ? [] : [`src-tauri/target/release/bundle/macos/${named}.app`]),
      `src-tauri/target/release/${name}`,
    ],
    ...(named === undefined ? {} : { installed: `/Applications/${named}.app` }),
  };
}

/** `codesign -dv` of one path, as it prints it (to stderr). Undefined when nothing ran. */
function codesignOf(path: string): Signature | undefined {
  if (!existsSync(path)) return undefined;
  const run = spawnSync('codesign', ['-dv', '--verbose=2', path], { encoding: 'utf8' });
  return parseCodesign(`${run.stdout}${run.stderr}`);
}

/** How to look at a project, injected so the decision is a unit test. */
export interface SigningProbe {
  read: (relative: string) => string | undefined;
  codesign?: (path: string) => Signature | undefined;
  platform?: NodeJS.Platform;
  /** The project folder the dev build's relative path is under. */
  dir?: string;
}

/** On macOS, the keychain note for the Tauri build Reticle drives, when it applies. */
export function keychainNoteFor(probe: SigningProbe): string | undefined {
  if ('darwin' !== (probe.platform ?? process.platform)) return undefined;
  const app = tauriDevBinary(probe.read);
  if (app === undefined) return undefined;
  const codesign = probe.codesign ?? codesignOf;
  const installed = app.installed === undefined ? undefined : codesign(app.installed);
  // Every build on disk, debug and release: a person with only a release build heard nothing.
  for (const build of [app.build, ...app.release]) {
    // macOS only, so a POSIX path on every host the unit test runs on.
    const note = signingNote(codesign(posix.join(probe.dir ?? process.cwd(), build)), installed);
    if (note !== undefined) return note;
  }
  return undefined;
}

/** A project folder's files, read relative to it. */
export const projectReader =
  (dir: string) =>
  (relative: string): string | undefined => {
    try {
      return readFileSync(isAbsolute(relative) ? relative : join(dir, relative), 'utf8');
    } catch {
      return undefined;
    }
  };

// ponytail: grows by one id per agent connection the daemon ever served; bound it if that matters.
const noticed = new Set<string>();

/**
 * The note for an agent session's first answer, then never again for that session: the person
 * flooded with password dialogs is talking to the agent, and may never run doctor.
 */
export function keychainNoticeOnce(attach: string, probe: SigningProbe): string | undefined {
  if (noticed.has(attach)) return undefined;
  noticed.add(attach);
  return keychainNoteFor(probe);
}
