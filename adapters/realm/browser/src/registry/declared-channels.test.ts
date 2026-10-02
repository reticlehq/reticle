import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelId } from '@reticlehq/core';
import { declaredChannels } from './declared-channels.js';
import { registerStore, storeNames, unregisterStore } from './stores.js';

/**
 * The declaration has to be true, and this is what makes it stay true.
 *
 * A build declaring a channel it cannot observe is scored on evidence it never had: a `state`
 * claim comes back empty, and an empty result reads exactly like "the value was not there". That
 * is a false verdict produced by an over-generous handshake, which is a worse failure than not
 * declaring at all — so the conditional half is tested from both sides.
 */

describe('what this build says it is watching', () => {
  beforeEach(() => {
    // The registry is module-global by design (a page has one). Cleared by name rather than by a
    // reset helper, so this test needs no production API that exists only for tests.
    for (const name of storeNames()) unregisterStore(name);
  });

  it('always claims the channels every connect installs an observer for', () => {
    const declared = declaredChannels();
    for (const always of [
      ChannelId.UI,
      ChannelId.NET,
      ChannelId.LOG,
      ChannelId.ROUTE,
      ChannelId.STORAGE,
      ChannelId.TIME,
      ChannelId.SIGNAL,
    ]) {
      expect(declared, `${always} is installed on every connect`).toContain(always);
    }
  });

  it('does NOT claim state until something registers a store', () => {
    // The one that matters. An app with no state adapter that claimed `state` would answer a
    // state assertion with an empty read, and an empty read is indistinguishable from a wrong
    // value — which is the false green this whole declaration exists to prevent.
    expect(declaredChannels()).not.toContain(ChannelId.STATE);
  });

  it('claims state once a store is registered', () => {
    registerStore('app', () => ({ count: 1 }));
    expect(declaredChannels()).toContain(ChannelId.STATE);
  });

  it('is read live, so a store registered after connect is not denied forever', () => {
    // A lazy route or an HMR remount registers its store well after the handshake. A declaration
    // computed once at startup would go on refusing a channel that has since appeared.
    expect(declaredChannels()).not.toContain(ChannelId.STATE);
    registerStore('late', () => ({}));
    expect(declaredChannels()).toContain(ChannelId.STATE);
  });

  it('never claims visual, which this side of the wire cannot produce', () => {
    // Pixels come from the debugging protocol or the desktop shell, both on the other side. A page
    // claiming it can be photographed is a page claiming access it does not have.
    registerStore('app', () => ({}));
    expect(declaredChannels()).not.toContain(ChannelId.VISUAL);
  });
});
