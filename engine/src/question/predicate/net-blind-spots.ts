/**
 * What the `net` channel cannot see, and what a miss over it is allowed to claim.
 *
 * The network observer patches `fetch` and `XMLHttpRequest`; a document-initiated subresource, a
 * native download and anything before the SDK attached never reach it. Each rule here exists so a
 * zero-match `net` verdict says "not observable" or names its blind stretch, instead of "never
 * happened". Split from `predicate-eval.ts`, which decides the verdict; this only knows the channel.
 *
 * Takes the filter's parts rather than the predicate, so it needs nothing from the contract. The
 * one exception is `unrecordedCallMiss`, which builds the whole `unknown` result for a net clause.
 */

import { unloadedInWindow, unpatchedInWindow } from '@/window/event-filters.js';
import { describeNetFilter, type EvalResult } from './predicate-eval-kit.js';

/**
 * URL suffixes only the DOCUMENT fetches, which the network observer therefore never records.
 *
 * `network.ts` patches `fetch` and `XMLHttpRequest` and nothing else, so `<link rel=icon>`,
 * `<link rel=manifest>`, stylesheets, fonts and `<img src>` are invisible to it. "No matching call"
 * and "that class of call is not observed" are then indistinguishable, and the miss graded
 * `assertion_failed` — a false RED. Reported from the field: an assert over `/favicon.ico`,
 * `/site.webmanifest` and `/apple-touch-icon.png` returned `verified:"no"` while curl showed all
 * three answering 200. A false negative here is worse than an unknown, because an agent that trusts
 * it goes and "fixes" working code.
 *
 * Deliberately NOT here: `.js` and `.json`. Both are routinely fetched via `fetch`/XHR — a module
 * preload and an API call can share a suffix — so downgrading them would hide real misses. This list
 * is only the suffixes for which the document is the sole plausible initiator.
 *
 * This began as the smaller half of #447: it did not make these requests observable, it stopped
 * Reticle claiming they did not happen. The other half, observing them via resource timing, has
 * since landed in the browser SDK, so the two halves are no longer independent and this downgrade is
 * now GATED: when the event stream carries at least one document-initiated record, the observer is
 * demonstrably live and a miss over these suffixes is real evidence, graded a plain failure. Only a
 * page whose stream holds no resource entry at all keeps the honest "cannot tell apart" answer,
 * because there the observer may simply not exist.
 */
const DOCUMENT_ONLY_SUFFIXES: readonly string[] = [
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.bmp',
  '.css',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.webmanifest',
];

/**
 * File suffixes a click typically downloads or navigates to as a document, never as fetch/XHR.
 *
 * Sibling of DOCUMENT_ONLY_SUFFIXES, not a member of it. Those are subresources: once resource
 * timing is live, a miss is evidence. A click on `<a href="/export.pdf">` is a navigation (or a
 * Content-Disposition attachment). Resource timing of stylesheets does not make it visible, so
 * grading the miss as "0 network calls" / a 404 is the lie #805 exists to stop — even on a page
 * whose observer is running. `.js` / `.json` stay off this list for the same reason they stay off
 * the other: they are routinely fetched.
 */
const NATIVE_DOWNLOAD_SUFFIXES: readonly string[] = [
  '.pdf',
  '.csv',
  '.tsv',
  '.zip',
  '.gz',
  '.tar',
  '.xlsx',
  '.xls',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.ods',
  '.odt',
  '.rtf',
  '.7z',
  '.rar',
];

/**
 * File suffixes a media element (`<video>`, `<audio>`, `<track>`) loads.
 *
 * Unlike DOCUMENT_ONLY_SUFFIXES this is not gated on a live resource-timing observer: Chromium does
 * not report media element loads as `resource` entries, so a page that plays the file leaves no
 * record however live the observer is. A miss over one of these says nothing about the file.
 */
const MEDIA_LOAD_SUFFIXES: readonly string[] = [
  '.mp4',
  '.m4v',
  '.webm',
  '.mov',
  '.ogv',
  '.m3u8',
  '.mp3',
  '.m4a',
  '.ogg',
  '.oga',
  '.wav',
  '.aac',
  '.flac',
  '.opus',
  '.vtt',
];

/**
 * Does this filter target a class of request the observer cannot see?
 *
 * Read off `urlContains` only, and only when the pattern ENDS in one of the suffixes — a filter of
 * `/api/` that happens to contain `.css` somewhere in a query string is still an ordinary XHR
 * target. Query strings and fragments are stripped first, since `favicon.ico?v=2` is the same asset.
 */
function filterPath(urlContains: string): string {
  return (urlContains.split('#')[0] ?? '').split('?')[0]?.toLowerCase() ?? '';
}

/**
 * Does this filter target a class of request the observer cannot see?
 *
 * Read off `urlContains` only, and only when the pattern ENDS in one of the suffixes — a filter of
 * `/api/` that happens to contain `.css` somewhere in a query string is still an ordinary XHR
 * target. Query strings and fragments are stripped first, since `favicon.ico?v=2` is the same asset.
 */
export function targetsUnobservedChannel(url: string | undefined): boolean {
  if (undefined === url) return false;
  return DOCUMENT_ONLY_SUFFIXES.some((suffix) => filterPath(url).endsWith(suffix));
}

export function targetsNativeDownload(url: string | undefined): boolean {
  if (undefined === url) return false;
  return NATIVE_DOWNLOAD_SUFFIXES.some((suffix) => filterPath(url).endsWith(suffix));
}

export function targetsMediaLoad(url: string | undefined): boolean {
  if (undefined === url) {
    return false;
  }
  return MEDIA_LOAD_SUFFIXES.some((suffix) => filterPath(url).endsWith(suffix));
}

/** `filter` is the net clause as applied — `describeNetFilter` of it. */
export function mediaLoadReason(filter: string): string {
  return (
    `no fetch or XHR matched ${filter}. A media element (<video>, <audio>, <track>) loads its ` +
    `source itself: the load goes through neither fetch nor XMLHttpRequest, and the browser does ` +
    `not report it as a resource timing entry, so media element loads are not observed and an ` +
    `empty net window is not evidence the file failed to load. Assert something that proves ` +
    `playback instead, for example an element check on the <video> or <audio>`
  );
}

/** `filter` is the net clause as applied — `describeNetFilter` of it. */
export function nativeDownloadReason(filter: string): string {
  return (
    `no fetch or XHR matched ${filter}. A native download or document navigation ` +
    `(an <a href> to a file, a Content-Disposition attachment, <a download>) never goes through ` +
    `fetch or XMLHttpRequest, so an empty net window is not a 404 and is not evidence the export ` +
    `failed. This is unobservable on the net channel. Assert the link href, or check the file ` +
    `outside the browser — Reticle cannot see the bytes land`
  );
}

/** The sentence both zero-match branches hand to `inconclusive`; `filter` as `nativeDownloadReason`. */
export function unobservedChannelReason(filter: string): string {
  return (
    `no call matched ${filter}, and no document-initiated load was recorded either, ` +
    `so this page exposed no resource timing to read: Reticle observes fetch and XMLHttpRequest ` +
    `directly, while a request the document initiates (<link rel=icon|manifest|preload>, a ` +
    `stylesheet, a font, <img src>) leaves no record, and that state cannot be told apart from the ` +
    `request having been made. ` +
    `Nothing here says the app is wrong. Check it outside the browser, or assert something the ` +
    `document does not fetch on its own`
  );
}

/**
 * Appended to a zero-match `net` negative whose window starts at SDK attach.
 *
 * Every event's `t` is stamped `performance.now() - #start`, where `#start` is taken when the SDK
 * is constructed, so `t` is never negative and a window with `since === 0` begins AT attach — never
 * before it. Whatever the page did between navigation start and attach left no event at all, so
 * "no matching call" over such a window cannot be told apart from "the call was made while nothing
 * was watching yet".
 *
 * The gap is routine rather than exotic: a `fetch` from an effect in a root provider, or a classic
 * `<script>` at the end of `<body>`, fires before a deferred module script has run. Read as proof
 * the request was never made, that sends a reader looking for a defect in code that works —
 * restarting dev servers and re-reading providers to establish that the request was invisible rather
 * than absent.
 *
 * Same argument as DOCUMENT_ONLY_SUFFIXES one axis over: that one is a channel Reticle does not
 * watch, this is a stretch of TIME it was not yet watching.
 *
 * The grade is deliberately NOT downgraded to `inconclusive`. A missing API call is the finding this
 * oracle exists to make, and it is the strongest grade available for the startup class — session
 * restore, feature flags, bootstrap config — which is exactly the class that silently breaks on
 * reload. Every window an action opens carries `since > 0` and is untouched. What changes is only
 * what the negative CLAIMS: it stops asserting the request never happened, and names the assertion
 * that can settle it, because the state such a request produces IS observable after attach.
 */
export const PRE_ATTACH_CAVEAT =
  ' — note that this window starts where the SDK attached, and requests made before that are never ' +
  'captured, so a miss here cannot tell a call that was never made apart from one made before the ' +
  'page connected; if the call is expected during startup, assert on the state it produces instead';

/** `filter` is the net clause as applied — `describeNetFilter` of it. */
export function earlierMediaReason(filter: string): string {
  return (
    `no fetch or XHR matched ${filter}, and the one media load that did match it was recorded ` +
    `before this window opened. The network observer reports only the first resource timing ` +
    `entry for a URL, and a media element load leaves no other record, so a repeat load inside ` +
    `this window is not reported either: the empty window cannot show the file did not load in ` +
    `it. Assert something that proves playback instead, for example an element check on the ` +
    `<video> or <audio>`
  );
}

/** The oracle that reports a miss over a request sent through an unpatched `fetch`. */
export const UNPATCHED_FETCH_ASSERTION = 'net.unpatched-fetch';

/**
 * Why a `net` miss is unknown when the browser recorded a matching request that no patched
 * transport saw. `filter` is the net clause as applied — `describeNetFilter` of it.
 *
 * A client library can store `window.fetch` when its module loads, before Reticle patches it. A
 * call through the stored function makes no `net.request`, so "no call matched" is false: the
 * server got the request (#1660).
 */
export function unpatchedFetchReason(filter: string): string {
  return (
    `no recorded call matched ${filter}, but the browser recorded a request to a matching URL ` +
    `that Reticle did not see. The request went through a fetch saved before Reticle connected ` +
    `(a client library that stores window.fetch when it loads does this). Its method, status and ` +
    `body are not known, so this clause cannot be judged. Connect Reticle earlier: add the build ` +
    `plugin (@reticlehq/vite-plugin or @reticlehq/next), which runs connect() before the app code`
  );
}

/** The oracle that reports a miss over a request whose page unloaded before its answer (#1944). */
export const PAGE_UNLOADED_ASSERTION = 'net.page-unloaded';

/**
 * Why a `net` miss is unknown when the page sent a matching request and then unloaded before the
 * answer arrived. `filter` is the net clause as applied — `describeNetFilter` of it.
 *
 * A click can send a POST and then load a new document. Nobody records an answer that comes after
 * the unload. The daemon carries the request into the new session marked `pageUnloaded`, so the
 * record says the page sent it. "No call matched" would say it never did (#1944).
 */
export function pageUnloadedReason(filter: string): string {
  return (
    `the page sent a request matching ${filter}, and then its document unloaded before the answer ` +
    'arrived. Nothing recorded the answer, so its status and body are unknown. This is not a ' +
    'missing request. To prove the outcome, assert the state the request makes on the new page, ' +
    'or make the request finish before the page navigates'
  );
}

/** The net clause a miss is judged against, as `describeNetFilter` takes it. */
type NetClause = Parameters<typeof describeNetFilter>[0];

/**
 * `unknown` when a matching call happened and its record cannot answer: no patched transport saw it
 * (#1660), or its page unloaded before the answer arrived (#1944). Else `undefined`. `observed` is
 * read only when the miss is reported.
 */
export function unrecordedCallMiss(
  events: Parameters<typeof unpatchedInWindow>[0],
  p: NetClause,
  observed: () => string,
): EvalResult | undefined {
  const since = p.since ?? 0;
  const filter = describeNetFilter(p);
  let reason = unpatchedFetchReason(filter);
  let assertion = UNPATCHED_FETCH_ASSERTION;
  if (!unpatchedInWindow(events, since, p.urlContains)) {
    if (!unloadedInWindow(events, since, p.method, p.urlContains)) {
      return undefined;
    }
    reason = pageUnloadedReason(filter);
    assertion = PAGE_UNLOADED_ASSERTION;
  }
  return {
    pass: false,
    failureReason: reason,
    inconclusive: reason,
    observed: observed(),
    expected: `a recorded call matching ${filter}`,
    assertion,
  };
}
