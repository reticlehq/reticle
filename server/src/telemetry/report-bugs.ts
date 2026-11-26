/**
 * `bug_found`: one event for each defect in the result of a tool. Called by `runTool`, the one place
 * where tool calls are counted.
 */
import { TelemetryActor, TelemetryEventKind, fingerprintFinding } from '@reticlehq/core';
import { getSessionMetrics } from './session-metrics.js';
import { getTelemetry } from './telemetry.js';
import { bugsInResult, routeOf } from './bug-found.js';
import { telemetryRuntimeOf } from './telemetry-runtime.js';
import { emitBugFoundHook } from '@/hooks/hook-emit.js';

/**
 * Emit one `bug_found` per defect in a tool result, and count it into the session.
 *
 * The outcome metric: everything else measures whether Reticle is used, this measures whether it
 * works. Discrete events rather than only a counter, because the KIND distribution is the argument —
 * "we found 4,000 bugs" is a claim, "1,200 were greens that lied" is evidence.
 */
export function reportBugsFound(
  toolName: string,
  result: Record<string, unknown>,
  sessionId: string | undefined,
  sessionRuntime?: string,
): void {
  const runtime = telemetryRuntimeOf(sessionRuntime);
  const bugs = bugsInResult(toolName, result);
  if (0 === bugs.length) {
    return;
  }
  const metrics = getSessionMetrics();
  const route = routeOf(result);
  for (const bug of bugs) {
    // `recordBug` answers whether this kind is new to the session, which is the only thing that
    // separates "another defect" from "the same defect again". Counting instances as defects is how
    // a published number inflates itself.
    const first = metrics.recordBug(bug.kind);
    const identity =
      route !== undefined
        ? { kind: bug.kind, source: bug.source, route }
        : { kind: bug.kind, source: bug.source };
    const fingerprint = fingerprintFinding(identity);
    const occurrence = metrics.recordBugOccurrence(fingerprint);
    void getTelemetry().emit(TelemetryEventKind.BUG_FOUND, {
      actor: TelemetryActor.AGENT,
      bug: {
        ...bug,
        repeat: !first,
        fingerprint,
        ...(occurrence === undefined ? {} : { occurrence }),
        ...(runtime === undefined ? {} : { runtime }),
      },
    });
    // The same defect, said out loud to whoever is building on Reticle. Inside the loop rather than
    // after it because the event is PER DEFECT — one event carrying a list would make a consumer
    // unpack it to answer "what was found", which is the question they are subscribing to ask.
    emitBugFoundHook(toolName, bug, { repeat: !first, fingerprint, route, sessionId });
  }
}
