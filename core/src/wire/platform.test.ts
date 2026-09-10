import { describe, expect, it } from 'vitest';
import { AppRuntime } from '../telemetry-feedback.js';
import { PlatformProfile } from './platform.js';
import { profileOfRuntime } from '../realm/registry.js';
import { HelloMessageSchema } from './messages.js';
import { MessageKind, RETICLE_PROTOCOL_VERSION } from './constants.js';

/**
 * What kind of surface is on the other end, told apart from which shell it happens to be.
 *
 * These two questions kept getting answered with one word. "Which shell is this?" is a question
 * about analytics -- Electron and Tauri are different products, and it matters which one somebody
 * is using. "What can I demand of you?" is a question about verification, and for that Electron and
 * Tauri are the same thing: a web page inside a native window.
 *
 * Twenty files branched on the shell when they meant the surface. Every one of them had to name
 * both Electron and Tauri, and every one of them would have to be edited again for a third shell
 * that behaves identically. Worse, the enum they were reading belongs to the telemetry contract, so
 * a decision about whether a verdict can be trusted was reaching into the part of the system that
 * reports usage.
 *
 * So there are two vocabularies now, and this states the relationship between them.
 */
describe('what kind of surface is on the other end', () => {
  it('has a profile for every shell we know about', () => {
    // A shell with no profile would be a connection nothing could decide what to demand of.
    const unmapped = Object.values(AppRuntime).filter(
      (runtime) => profileOfRuntime(runtime) === undefined,
    );
    expect(unmapped).toEqual([]);
  });

  it('gives the two desktop shells the same profile, because they are the same surface', () => {
    // The whole reason this exists. If these ever differ, the split has stopped paying for itself.
    expect(profileOfRuntime(AppRuntime.ELECTRON)).toBe(PlatformProfile.WEBVIEW);
    expect(profileOfRuntime(AppRuntime.TAURI)).toBe(PlatformProfile.WEBVIEW);
  });

  it('is not simply a copy of the shell list under another name', () => {
    // Three shells, four profiles, and two of the shells share one. A profile set that matched the
    // shell set one-for-one would be a rename rather than a distinction.
    expect(Object.values(PlatformProfile).length).not.toBe(Object.values(AppRuntime).length);
    const profiles = new Set(Object.values(AppRuntime).map((r) => profileOfRuntime(r)));
    expect(profiles.size).toBeLessThan(Object.values(AppRuntime).length);
  });

  it('describes surfaces nothing here implements yet, on purpose', () => {
    // `native` and `service` exist so a third-party implementation has a truthful thing to say
    // about itself. Leaving them out would force a phone to call itself a browser.
    expect(Object.values(PlatformProfile)).toContain(PlatformProfile.NATIVE);
    expect(Object.values(PlatformProfile)).toContain(PlatformProfile.SERVICE);
  });
});

describe('the handshake carries the surface', () => {
  it('accepts a connection that says what surface it is', () => {
    const hello = {
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: 'demo',
      url: 'http://localhost/',
      title: 'Demo',
      adapters: [],
      platform: PlatformProfile.NATIVE,
    };
    const parsed = HelloMessageSchema.safeParse(hello);
    expect(parsed.success && parsed.data.platform).toBe(PlatformProfile.NATIVE);
  });

  it('accepts a connection that does not, because everything before this was the web', () => {
    // The back-compat rule, asserted rather than assumed. An SDK built before this field existed
    // must keep connecting, and it must not be read as "surface unknown".
    const parsed = HelloMessageSchema.safeParse({
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: 'demo',
      url: 'http://localhost/',
      title: 'Demo',
      adapters: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.platform).toBeUndefined();
  });

  it('refuses a surface nobody has defined', () => {
    const parsed = HelloMessageSchema.safeParse({
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: 'demo',
      url: 'http://localhost/',
      title: 'Demo',
      adapters: [],
      platform: 'hologram',
    });
    expect(parsed.success).toBe(false);
  });
});
