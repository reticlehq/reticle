import { describe, it, expect } from 'vitest';
import { INTENT_TOOLS } from './intent-tools.js';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { recoveryFor } from '@/surface/tools/error-recovery.js';
import type { ToolDeps } from '@/surface/tools/tools.js';

/**
 * Found by calling every action of `reticle_intent` with what its schema documents. `record` with
 * `subject`, `statement` and `why` failed with zod's "intents..id: String must contain at least 1
 * character(s)" and the ask to report a Reticle defect, because `id` is documented as "bind only".
 * `get`, `subject` and `bind` with their argument missing answered `{ record: null }`, `{ records:
 * [] }` and `{ bound: false }`, which read as "there is none" instead of "you did not say which".
 */
const tool = INTENT_TOOLS.find((t) => t.name.includes('intent'));

function deps(): ToolDeps {
  const { fs } = createMemoryFs();
  return {
    fs,
    reticleRoot: '/repo/.reticle',
    now: () => 1,
    sessions: { resolve: () => ({ id: 's1', url: 'http://app.test/', projectId: undefined }) },
  } as unknown as ToolDeps;
}

const refusal = async (args: Record<string, unknown>): Promise<string> => {
  try {
    await tool?.handler(deps(), args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

describe('reticle_intent names the argument an action is missing', () => {
  it.each([
    [{ action: 'record', subject: 'deployments', statement: 'A new deploy is listed.' }, 'id'],
    [{ action: 'record', id: 'i-1', subject: 'deployments' }, 'statement'],
    [{ action: 'get' }, 'id'],
    [{ action: 'subject' }, 'subject'],
    [{ action: 'bind' }, 'id'],
  ])('%j is refused, naming `%s`', async (args, missing) => {
    const message = await refusal(args);
    expect(message).toContain(`\`${missing}\``);
    // Our refusal about the caller's call, never "may be a defect in Reticle".
    expect(recoveryFor(message)).toMatch(/did not match the tool's schema/);
  });

  it('still records an intent that names its id and statement', async () => {
    const d = deps();
    const out = (await tool?.handler(d, {
      action: 'record',
      id: 'i-1',
      subject: 'deployments',
      statement: 'A new deploy is listed.',
    })) as { record?: { id?: string } };
    expect(out.record?.id).toBe('i-1');
  });
});
