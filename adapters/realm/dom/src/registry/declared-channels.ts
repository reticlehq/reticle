import { ChannelId } from '@reticlehq/core';
import { storeNames } from './stores.js';

/**
 * What this build can honestly say it is watching.
 *
 * The protocol calls this the first assertion an implementation makes, and until now this
 * implementation never made it. `hello.channels` has existed on the wire schema for a while and
 * nothing anywhere set it — so the rule that refuses a claim reading an unwatched channel had
 * nothing to read, and the conformance scenario for it could not be scored against us. We wrote
 * the rule and then did not follow it.
 *
 * The declaration must be TRUE rather than aspirational, and the two halves differ:
 *
 * **Fixed.** The observers installed on every connect. A page always has somewhere errors go, a
 * network stack, a document, a location and a clock, so these are unconditional and claiming them
 * costs nothing.
 *
 * **Conditional.** `state` is real only when something registered a store. A build with no state
 * adapter that declared `state` anyway would be scored on evidence it never had, and would answer
 * a `state` claim with an empty result that reads exactly like "the value was not there". That is
 * the false verdict this whole mechanism exists to prevent, so the check is a live one rather than
 * a build-time guess.
 *
 * ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────────────────────────
 * `visual`. Pixels do not come from this SDK — a tab is photographed through the debugging
 * protocol and a desktop window through its shell, both of which live on the other side of the
 * wire. A page claiming it can be photographed would be a page claiming a capability it has no
 * access to, and the honest place for that declaration is whoever owns the camera.
 */
export function declaredChannels(): ChannelId[] {
  const fixed = [
    // The document, and everything addressable in it.
    ChannelId.UI,
    // fetch/XHR/beacon, patched at connect. On desktop this also carries `ipc://`.
    ChannelId.NET,
    // console + uncaught errors + unhandled rejections.
    ChannelId.LOG,
    // history/hash/navigation.
    ChannelId.ROUTE,
    // cookies, localStorage, sessionStorage.
    ChannelId.STORAGE,
    // Whether the window went quiet, and what was still outstanding when it did.
    ChannelId.TIME,
    // The app's own announcements. The channel is watched whether or not the app ever fires one --
    // an app that emits no signal is an app with nothing on this channel, which is a different
    // fact from an implementation that would not have seen one.
    ChannelId.SIGNAL,
  ];
  // Live, not cached: a store can register after connect (a lazy route, an HMR remount), and a
  // declaration made once at startup would go on denying a channel that has since appeared.
  return storeNames().length > 0 ? [...fixed, ChannelId.STATE] : fixed;
}
