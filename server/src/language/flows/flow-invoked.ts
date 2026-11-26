/**
 * The sub-flows a saved flow calls with `invoke`, read at save so the classifier can credit them.
 *
 * Split out of `flow-tools.ts` at its 1000-line cap.
 */
import type { FlowFile, ProjectId } from '@reticlehq/core';
import { flattenSteps } from './flow-classify.js';

/**
 * Every flow reachable from this one by `invoke`, loaded once.
 *
 * Breadth-first with a `seen` set so a cycle terminates: typecheck refuses those at rest, and this
 * runs at SAVE, which is exactly where a bad composite arrives before anything has checked it.
 *
 * A sub-flow that fails to load is simply absent from the map. The classifier then declines to
 * credit it, which is the conservative direction — a composite graded on a flow nobody could read
 * would be graded on a promise.
 */
export async function loadInvoked(
  flows: {
    load: (name: string, projectId?: ProjectId) => Promise<{ ok: boolean; value?: FlowFile }>;
  },
  flow: FlowFile,
  projectId?: ProjectId,
): Promise<Map<string, FlowFile>> {
  const out = new Map<string, FlowFile>();
  const queue = [flow];
  const seen = new Set<string>([flow.name]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const step of flattenSteps(current.steps)) {
      const name = step.invoke;
      if (name === undefined || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const sub = await flows.load(name, projectId);
      if (!sub.ok || sub.value === undefined) {
        continue;
      }
      out.set(name, sub.value);
      queue.push(sub.value);
    }
  }
  return out;
}
