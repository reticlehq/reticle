import { describe, expect, it } from 'vitest';
import {
  KEYCHAIN_NOTE,
  keychainNoteFor,
  keychainNoticeOnce,
  parseCodesign,
  type Signature,
  signingNote,
  tauriDevBinary,
} from './doctor-signing-line.js';

/*
 * From the field: a signed macOS Tauri app driven by Reticle flooded its user with password dialogs.
 * macOS ties keychain items to the app's signature, and the build Reticle runs is ad-hoc signed, so
 * every keychain read of that build asks. Doctor says so once, plainly.
 */
const ADHOC = [
  'Executable=/app/src-tauri/target/debug/shop',
  'Identifier=shop-dd79a7f6af99bd01',
  'CodeDirectory v=20400 size=77336 flags=0x20002(adhoc,linker-signed) hashes=2413+0',
  'Signature=adhoc',
  'TeamIdentifier=not set',
].join('\n');
const SIGNED = [
  'Identifier=com.acme.shop',
  'Authority=Developer ID Application: Acme Inc (ABCDE12345)',
  'TeamIdentifier=ABCDE12345',
].join('\n');

describe('reading codesign -dv', () => {
  it('reads an ad-hoc build, a team-signed one, and an unsigned one', () => {
    expect(parseCodesign(ADHOC)).toEqual({ adhoc: true, identifier: 'shop-dd79a7f6af99bd01' });
    expect(parseCodesign(SIGNED)).toEqual({
      adhoc: false,
      identifier: 'com.acme.shop',
      teamId: 'ABCDE12345',
    });
    expect(parseCodesign('/app/shop: code object is not signed at all')).toEqual({ adhoc: true });
    expect(parseCodesign('')).toBeUndefined();
  });
});

describe('the keychain note', () => {
  it('speaks for an ad-hoc build, and for one signed by another team than the installed app', () => {
    expect(signingNote(parseCodesign(ADHOC), undefined)).toBe(KEYCHAIN_NOTE);
    expect(signingNote(parseCodesign(SIGNED), { adhoc: false, teamId: 'ZZZZZ99999' })).toBe(
      KEYCHAIN_NOTE,
    );
  });

  it('says nothing when the build is signed like the installed app, or was not read', () => {
    expect(signingNote(parseCodesign(SIGNED), { adhoc: false, teamId: 'ABCDE12345' })).toBe(
      undefined,
    );
    expect(signingNote(parseCodesign(SIGNED), undefined)).toBe(undefined);
    expect(signingNote(undefined, undefined)).toBe(undefined);
  });
});

describe('the Tauri build Reticle drives', () => {
  it('is the cargo package under target/debug, and its installed copy is named by productName', () => {
    const files: Record<string, string> = {
      'src-tauri/Cargo.toml': '[package]\nname = "shop"\nversion = "0.1.0"\n',
      'src-tauri/tauri.conf.json': '{"productName":"Shop"}',
    };
    expect(tauriDevBinary((p) => files[p])).toEqual({
      build: 'src-tauri/target/debug/shop',
      release: ['src-tauri/target/release/bundle/macos/Shop.app', 'src-tauri/target/release/shop'],
      installed: '/Applications/Shop.app',
    });
    expect(tauriDevBinary(() => undefined)).toBeUndefined();
  });
});

/*
 * Doctor said it, the agent's session did not — the person whose app floods them with
 * password dialogs is talking to the agent, not running doctor. The first answer of an agent session
 * on a Tauri project whose dev build is signed differently carries the note, once.
 */
describe('the keychain note on an agent session’s first answer', () => {
  const tauriProject = (relative: string): string | undefined =>
    ({
      'src-tauri/Cargo.toml': 'name = "shop"',
      'src-tauri/tauri.conf.json': '{"productName":"Shop"}',
    })[relative];
  const adhoc = (): Signature => ({ adhoc: true });

  it('is given once per agent session on macOS, for a build signed differently', () => {
    const note = (attach: string) =>
      keychainNoticeOnce(attach, { read: tauriProject, codesign: adhoc, platform: 'darwin' });
    expect(note('agent-1')).toBe(KEYCHAIN_NOTE);
    expect(note('agent-1')).toBeUndefined();
    expect(note('agent-2')).toBe(KEYCHAIN_NOTE);
  });

  it('is not given off macOS, for a web project, or for a build signed like the installed app', () => {
    const signed = (): Signature => ({ adhoc: false, identifier: 'shop', teamId: 'T1' });
    expect(
      keychainNoticeOnce('a', { read: tauriProject, codesign: adhoc, platform: 'linux' }),
    ).toBeUndefined();
    expect(
      keychainNoticeOnce('b', { read: () => undefined, codesign: adhoc, platform: 'darwin' }),
    ).toBeUndefined();
    expect(
      keychainNoticeOnce('c', { read: tauriProject, codesign: signed, platform: 'darwin' }),
    ).toBeUndefined();
  });
});

// Re-check: with only a release build on disk, doctor read the absent debug build and said
// nothing about a release bundle that was ad-hoc signed.
describe('the keychain note with only a release build', () => {
  it('reads the release bundle when there is no debug build', () => {
    const read = (relative: string): string | undefined =>
      ({
        'src-tauri/Cargo.toml': 'name = "shop"',
        'src-tauri/tauri.conf.json': '{"productName":"Shop"}',
      })[relative];
    const codesign = (path: string): Signature | undefined =>
      path.endsWith('release/bundle/macos/Shop.app') ? { adhoc: true } : undefined;
    expect(keychainNoteFor({ read, codesign, platform: 'darwin', dir: '/p' })).toBe(KEYCHAIN_NOTE);
  });
});
