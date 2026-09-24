/**
 * The event vocabulary: every normalized type the ring buffer can hold.
 *
 * Split out of `constants.ts` when that file crossed the 1000-line cap while gaining a channel for
 * form fields. Cohesive on its own terms, and the most-read list in the contract: this is the set an
 * observer produces, a predicate reasons over and a replayed step's digest counts, and each member
 * carries the argument for why that channel exists at all.
 *
 * Re-exported from `constants.ts`, so `EventType` stays one import path for everyone outside core.
 */
export const EventType = {
  DOM_ADDED: 'dom.added',
  DOM_REMOVED: 'dom.removed',
  DOM_ATTR: 'dom.attr',
  DOM_TEXT: 'dom.text',
  NET_REQUEST: 'net.request',
  NET_PENDING: 'net.pending',
  /** An SSE (EventSource) or WebSocket frame — a message on a long-lived streaming connection. */
  NET_STREAM: 'net.stream',
  /** A web-perf metric a screenshot can't verify: LCP, cumulative layout shift, or a long task. */
  PERF: 'perf',
  ROUTE_CHANGE: 'route.change',
  CONSOLE_LOG: 'console.log',
  CONSOLE_WARN: 'console.warn',
  CONSOLE_ERROR: 'console.error',
  CONSOLE_INFO: 'console.info',
  CONSOLE_DEBUG: 'console.debug',
  ERROR_UNCAUGHT: 'error.uncaught',
  VISIBLE_SHOWN: 'visible.shown',
  ANIM_START: 'anim.start',
  ANIM_END: 'anim.end',
  SCROLL_POSITION: 'scroll.position',
  REVEAL_SHOWN: 'reveal.shown',
  SIGNAL: 'signal',
  STATE_CHANGE: 'state.change',
  /** a write to localStorage/sessionStorage/cookies — `data: { area, key, old?, new? }` (values redacted). */
  STORAGE_CHANGE: 'storage.change',
  /** page-level visibility/focus health (distinct from element-level VISIBLE_*). */
  PAGE_HEALTH: 'page.health',
  /**
   * synthetic: the page called window.open, so the consequence of what was just clicked may live in
   * another browsing context this one cannot observe (an OAuth popup is the archetype).
   * `data: { href }` — the URL the page asked to open, when it named one.
   */
  CONTEXT_OPENED: 'context.opened',
  /**
   * The app opened a native `alert`/`confirm`/`prompt` while Reticle was driving it.
   *
   * Recorded because Reticle ANSWERS these rather than letting them block — a native dialog halts
   * the main thread, and the SDK's own message pump is on that thread, so one `confirm` behind a
   * driven click made the tab permanently unresponsive with no recovery from inside the session.
   * Answering silently would trade a wedge for an invisible one, so the question the app asked, and
   * the answer given, ride out as an event.
   */
  DIALOG_OPENED: 'dialog.opened',
  /** aggregated React commits over a throttle window (dev builds) — `data: { commits }`. Commit storms /
   * wasted re-renders show up here without a per-render flood. */
  RENDER_COMMIT: 'render.commit',
  /** element focus moved — `data: { to, from, toBody }`. Focus dropping to body after an act is a regression. */
  FOCUS_CHANGE: 'focus.change',
  /**
   * a form field's value moved — `data: { field, kind, value?, redacted?, length }`.
   *
   * The DOM observer never saw this: `value` is in its attribute allowlist, but React and every
   * controlled input set the PROPERTY, so `MutationObserver` does not fire. `value` is omitted and
   * `redacted` set for a password, a sensitive name, or a payment autocomplete hint; `length` is
   * always present, because "it was wiped" is assertable without carrying anybody's data.
   */
  FIELD_CHANGE: 'field.change',
  /** browser → bridge: a human recording compiled in-page. */
  FLOW_RECORDED: 'flow.recorded',
  /** synthetic: browser transport queue overflowed; events were dropped. `data: { dropped: number }`. */
  TRANSPORT_OVERFLOW: 'transport.overflow',
  /**
   * synthetic: a per-channel cap truncated a batch (e.g. a DOM mutation flood). `data: { channel, dropped }`.
   * Marks downstream rollups/envelopes as built on incomplete data — a ledger that lies at scale is worse
   * than no ledger, so truncation is never silent.
   */
  TRUNCATED: 'truncated',
  /**
   * synthetic: the SDK detected a region it CANNOT observe (a cross-origin iframe, a closed shadow root).
   * `data: { kind: BlindSpotKind, count }`. Surfaced on results as `coverage: partial` so a green never
   * implies it saw everything.
   */
  BLIND_SPOT: 'blind-spot',
  /** synthetic: the SDK ITSELF failed (an observer threw). `data: { site, message, errorType }`.
   *  Rides the existing bridge — no outbound request. See browser/observers/sdk-failure.ts. */
  SDK_FAILED: 'sdk.failed',
  /**
   * synthetic (driven only): CDP/Playwright-authoritative network detail for a response the in-page
   * fetch/XHR wrapper also saw — full response headers + authoritative status/mimeType the page-side
   * wrapper can't reach. `data: { url, method?, status, headers, resourceType? }`. Merged onto the
   * matching in-page NET_REQUEST so the driven view never loses fidelity to an outside-in tool.
   */
  NET_DETAIL: 'net.detail',
  /**
   * Live-control: browser → bridge. A human acted on the presenter panel.
   * `data: { kind: HumanControlKind; text?: string }`. Rides the existing EventMessage.
   */
  HUMAN_CONTROL: 'human.control',
  /**
   * Human review: browser → bridge. A human pinned a mistake to an element on the running page
   * (the "annotate the bug where you see it" loop). `data` narrows to HumanMarkDataSchema — a note
   * plus a re-resolvable element anchor (and its source file:line when the framework stamped one) so
   * the agent that drains the mark knows exactly which element and which source to fix.
   */
  HUMAN_MARK: 'human.mark',
  /**
   * The app produced a FILE — a Blob handed to `URL.createObjectURL`, usually saved by clicking an
   * anchor with `download`. `data: { filename?, mimeType, bytes, lines?, preview? }`. The one artifact
   * class no outside-the-browser tool can inspect: it never crosses the network, so there is no
   * request to intercept. See `observers/download.ts` for the defect that motivated it.
   */
  DOWNLOAD: 'download',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];
