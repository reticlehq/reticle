import { EventType, type IrisEvent } from '@syrin/iris-protocol';

export interface ReactionSummary {
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

export interface ReactionReport {
  window_ms: number;
  events: IrisEvent[];
  summary: ReactionSummary;
}

/** Turn a slice of the event buffer into the structured "what the app did" report (plan/05). */
export function buildReactionReport(events: IrisEvent[], windowMs: number): ReactionReport {
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
