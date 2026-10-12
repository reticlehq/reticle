/**
 * From persona drives: the Harness pressed Invite in a customer's workspace though its journey
 * said "she does not send an invite". Every command the Harness sends carries the outward actions
 * its journey asks for, and the page presses no other; a saved flow's steps and an agent's are not
 * gated.
 */
import { describe, expect, it } from 'vitest';
import { commandPayload } from './command-payload.js';
import { runDrivenBy, runSavedFlow } from '@/hooks/driven-by.js';

const sent = (): Record<string, unknown> =>
  JSON.parse(commandPayload('c1', 's1', 'act', { ref: 'e1', action: 'click' })) as Record<
    string,
    unknown
  >;

describe('the outward actions a command may take', () => {
  it('a Harness command carries what its journey asks for, and a "does not" asks for nothing', async () => {
    const by = (persona: string) => ({ harness: 'h1', driver: 'server', persona });
    const asked = (words: string) => runDrivenBy(by('x'), () => Promise.resolve(sent()), words);
    expect(await asked('Invite a teammate by email')).toMatchObject({
      outward: { allowed: ['invite'] },
    });
    expect(await asked('Tess limits a contractor. She does not send an invite.')).toMatchObject({
      outward: { allowed: [] },
    });
    // A planner's journey text is not a request: "press Invite" in a plan allows nothing.
    expect(
      await runDrivenBy(by('First-time visitor: press Invite'), () => Promise.resolve(sent())),
    ).toMatchObject({ outward: { allowed: [] } });
  });

  it('an agent command and a saved flow step are not gated', async () => {
    expect(sent()['outward']).toBeUndefined();
    const step = await runDrivenBy({ harness: 'h1', driver: 'server', persona: 'x' }, () =>
      runSavedFlow(() => Promise.resolve(sent())),
    );
    expect(step['outward']).toBeUndefined();
  });
});
