import { describe, expect, it, vi } from 'vitest';
import { ReticleCommand } from '@reticlehq/core';
import { createFakeSession } from './fake-session.js';

/**
 * A command the page said it does not serve is refused before it is sent.
 *
 * The protocol's rule is that an implementation declares what it can do and refuses everything
 * else, and the whole value of refusing is that it happens BEFORE the action is spent. Without
 * the declaration the only way to find out was to send the command and wait: eight seconds, then
 * a timeout whose message is about the page being slow. For a command the page was never going to
 * answer, that reads as an unhealthy application rather than a request it does not serve, and it
 * sends whoever is reading to debug the wrong thing.
 *
 * The other half matters more. `commands` is optional, and an SDK too old to declare sends
 * nothing. Silence must read as UNKNOWN and never as an empty list: treating it as "serves
 * nothing" would refuse every command from every older page in the field, which is a far worse
 * failure than the one this fixes.
 */

describe('a page is only asked for what it said it serves', () => {
  it('refuses a command absent from the declaration, without sending it', async () => {
    const session = createFakeSession({ commands: [ReticleCommand.SNAPSHOT] });
    const sent = vi.fn();
    const result = await session.command('drop_everything');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not serve');
    expect(sent).not.toHaveBeenCalled();
  });

  it('names what the page DOES serve, so the refusal is actionable', async () => {
    const session = createFakeSession({
      commands: [ReticleCommand.SNAPSHOT, ReticleCommand.QUERY],
    });
    const result = await session.command('nonsense');
    expect(result.error).toContain(ReticleCommand.SNAPSHOT);
    expect(result.error).toContain(ReticleCommand.QUERY);
  });

  it('says plainly that nothing happened, so it is not read as a broken app', async () => {
    // A refusal and a failure send a reader in opposite directions. This one has to say which
    // it is, in the sentence, because the sentence is all anybody sees.
    const session = createFakeSession({ commands: [ReticleCommand.SNAPSHOT] });
    const result = await session.command('nope');
    expect(result.error).toContain('not a failure of the app');
  });

  it('does NOT refuse when the page declared nothing, because that means too old to say', async () => {
    // The direction that matters. An empty-list reading here would refuse every command from
    // every page running an older SDK -- a much larger failure than the one being prevented.
    const session = createFakeSession({ commands: undefined });
    const pending = session.command(ReticleCommand.SNAPSHOT, {}, 20);
    // It was SENT, so it times out rather than being refused. The timeout is the evidence.
    await expect(pending).rejects.toThrow();
  });

  it('lets a declared command through', async () => {
    const session = createFakeSession({ commands: [ReticleCommand.SNAPSHOT] });
    const pending = session.command(ReticleCommand.SNAPSHOT, {}, 20);
    await expect(pending).rejects.toThrow(/timed out/);
  });
});
