import { ActionType, type FlowFile, type FlowStep } from '@reticlehq/core';
import { rewriteUploadArgs } from '../tools/real-input-attempt.js';
import type { ToolDeps } from '../tools/tools.js';

/**
 * Turn a recorded upload's `path` into the bytes the browser can actually take, once, before replay
 * runs a single step.
 *
 * The recorder and the replayer disagreed about what an upload step IS, and the disagreement was
 * total: `reticle_record` writes `{"action":"upload","args":{"path":"test-fixtures/pipe.step"}}` —
 * the only form the live `reticle_act` accepts, and the form that works interactively — while replay
 * dispatched it straight at the browser, which refused with "upload does not read path, so it would
 * be dropped". A recorded upload could therefore never replay as recorded. The capability was there
 * the whole time: an agent who hand-patched the flow JSON to `{name, content, type}` got a real
 * upload, a real `POST /api/v0/files -> 200`, and the app went on to perceive the file.
 *
 * Resolved HERE rather than at each of the four dispatch sites inside replay, and rather than at
 * save time: the flow file stays small and legible, the fixture stays on disk where it can be
 * reviewed and updated, and a flow that names a file nobody checked in fails saying so instead of
 * carrying a stale copy of it.
 *
 * `rewriteUploadArgs` is the same function the live path uses, so the two cannot drift again — which
 * is the whole reason this defect existed.
 */
export async function resolveFlowUploads(
  deps: Pick<ToolDeps, 'fs' | 'reticleRoot'>,
  flow: FlowFile,
): Promise<FlowFile> {
  const resolveStep = async (step: FlowStep): Promise<FlowStep> => {
    const nested = step.steps;
    const steps = nested === undefined ? undefined : await Promise.all(nested.map(resolveStep));
    const isUpload = step.action === ActionType.UPLOAD && step.args?.['path'] !== undefined;
    const args = isUpload
      ? await rewriteUploadArgs(deps, ActionType.UPLOAD, step.args ?? {})
      : step.args;
    return {
      ...step,
      ...(args === undefined ? {} : { args }),
      ...(steps === undefined ? {} : { steps }),
    };
  };
  // Untouched flows are returned as-is so the common journey allocates nothing and the on-disk file
  // and the replayed one stay the same object to compare.
  if (!hasUpload(flow.steps)) return flow;
  return { ...flow, steps: await Promise.all(flow.steps.map(resolveStep)) };
}

function hasUpload(steps: readonly FlowStep[]): boolean {
  return steps.some(
    (s) =>
      (s.action === ActionType.UPLOAD && s.args?.['path'] !== undefined) ||
      (s.steps !== undefined && hasUpload(s.steps)),
  );
}
