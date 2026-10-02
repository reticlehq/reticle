import { type ProjectId, FlowErrorCode, FlowFileSchema, type FlowFile } from '@reticlehq/core';
import { describeFlowZodFailure } from './flow-expect-grammar.js';
import { isValidFlowName } from '@/memory/project/dir/reticle-dir.js';
import { safeProjectId, type FlowResult } from './flow-result.js';

/**
 * Change one thing about a saved flow, and write the same file that load resolved.
 *
 * The shape two writers need — `heal` rebinding an anchor, `recordLearned` storing what a replay
 * learned — and which both spelled out separately until one of them got it wrong.
 *
 * Three properties, each paid for:
 *
 *  - The NAME is guarded before any path is joined, so a traversal name never reaches the disk.
 *  - The write goes to the path LOAD resolved (nested if the flow lives there, else legacy flat), so
 *    a change never forks a second copy of a flow.
 *  - It VALIDATES before writing. `load` validates; a writer that does not authors files its own
 *    reader rejects — and that is not hypothetical. A cross-step finding is addressed as step -1
 *    while the schema said non-negative, so the first one written made the flow unloadable forever.
 *    Replay, heal and the suite all lost it, and it read as user corruption rather than our write.
 *
 * Deliberately NOT `saveFlow`, which re-runs intent linking over the whole document and reverted an
 * intent a replay had just discharged. A whole-document save is not a field update: it re-applies
 * every rule the document has ever been subject to.
 */
export interface NarrowWritePort {
  load: (name: string, projectId?: ProjectId) => Promise<FlowResult<FlowFile>>;
  resolvePath: (name: string, projectId?: ProjectId) => Promise<string | null>;
  write: (path: string, contents: string) => Promise<void>;
  serialize: (flow: FlowFile) => string;
}

export async function changeInPlace<T>(
  port: NarrowWritePort,
  name: string,
  projectId: ProjectId | undefined,
  change: (flow: FlowFile) => { next: FlowFile; value: T },
): Promise<FlowResult<T>> {
  if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
  const pid = safeProjectId(projectId);
  const loaded = await port.load(name, pid);
  if (!loaded.ok) return { ok: false, code: loaded.code };
  const path = await port.resolvePath(name, pid);
  if (null === path) return { ok: false, code: FlowErrorCode.NOT_FOUND };
  const { next, value } = change(loaded.value);
  const parsed = FlowFileSchema.safeParse(next);
  if (!parsed.success) {
    return {
      ok: false,
      code: FlowErrorCode.PARSE_FAILED,
      detail: describeFlowZodFailure(parsed.error),
    };
  }
  await port.write(path, port.serialize(parsed.data));
  return { ok: true, value };
}
