import { EventType, type ReticleEvent } from '@reticlehq/protocol';

interface ReactionSummary {
  total: number;
  network: number;
  domAdded: number;
  domRemoved: number;
  domChanged: number;
  routeChanges: number;
  consoleErrors: number;
  animations: number;
  signals: number;
}

interface ReactionReport {
  window_ms: number;
  events: ReticleEvent[];
  summary: ReactionSummary;
}

/** Turn a slice of the event buffer into the structured "what the app did" report (plan/05). */
export function buildReactionReport(events: ReticleEvent[], windowMs: number): ReactionReport {
  const summary: ReactionSummary = {
    total: events.length,
    network: 0,
    domAdded: 0,
    domRemoved: 0,
    domChanged: 0,
    routeChanges: 0,
    consoleErrors: 0,
    animations: 0,
    signals: 0,
  };
  for (const e of events) {
    switch (e.type) {
      case EventType.NET_REQUEST:
        summary.network += 1;
        break;
      case EventType.DOM_ADDED:
        summary.domAdded += 1;
        break;
      case EventType.DOM_REMOVED:
        summary.domRemoved += 1;
        break;
      case EventType.DOM_ATTR:
      case EventType.DOM_TEXT:
        summary.domChanged += 1;
        break;
      case EventType.ROUTE_CHANGE:
        summary.routeChanges += 1;
        break;
      case EventType.CONSOLE_ERROR:
      case EventType.ERROR_UNCAUGHT:
        summary.consoleErrors += 1;
        break;
      case EventType.ANIM_START:
      case EventType.ANIM_END:
        summary.animations += 1;
        break;
      case EventType.SIGNAL:
        summary.signals += 1;
        break;
      default:
        break;
    }
  }
  return { window_ms: windowMs, events, summary };
}

/** The lean form of a reaction report: window + counts, WITHOUT the heavy per-event timeline. */
interface ReactionDigest {
  window_ms: number;
  summary: ReactionSummary;
}

/**
 * Drop the per-event `events` array, keeping the window and counts. The counts already answer "what
 * did the app do?" (DOM added/removed/changed, network, signals…), and a predicate verdict carries
 * the matching evidence — so a tool returning this digest stays cheap while the full timeline is one
 * `reticle_observe { since }` away when the agent needs it. On a large DOM the events array dominates
 * the cost (hundreds of tokens of mutations); the digest is a handful.
 */
export function summarizeReaction(report: ReactionReport): ReactionDigest {
  return { window_ms: report.window_ms, summary: report.summary };
}
