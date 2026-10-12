import { describe, expect, it } from 'vitest';
import {
  KEYCHAIN_NOTE,
  parseCodesign,
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
      installed: '/Applications/Shop.app',
    });
    expect(tauriDevBinary(() => undefined)).toBeUndefined();
  });
});
