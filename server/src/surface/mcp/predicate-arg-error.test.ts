/**
 * The readable predicate error has to reach the path agents actually use.
 *
 * `parsePredicate` was written so a malformed predicate never comes back as a serialized zod issue
 * array. It works — on the paths that call it. But the MCP SDK validates tool input against the same
 * schema BEFORE the handler runs, and its rejection is exactly the array: `[{ "code":
 * "unrecognized_keys", "keys": ["selector","minCount"], ... }]`. So on `reticle_assert`,
 * `reticle_wait_for` and `reticle_act_and_wait` — the only three tools that produce a verdict —
 * agents were still getting the array, naming the fields that failed and not one field that would
 * have worked.
 *
 * Found by driving a live app over MCP rather than by any test, which is the point: every unit test
 * here called the handler directly and so never crossed the layer that was broken.
 */

import { describe, expect, it } from 'vitest';
import { installFriendlyArgErrors } from './mcp.js';
import { PredicateKind } from '@reticlehq/core';

/** The SDK surface `installFriendlyArgErrors` wraps, reduced to the one method it overrides. */
function serverThatRejects(message: string): {
  validate: (args: unknown) => Promise<unknown>;
} {
  const server = {
    validateToolInput: () => {
      throw new Error(`MCP error -32602: ${message}`);
    },
  };
  installFriendlyArgErrors(
    server as never,
    new Map([['reticle_assert', '{"predicate":{"kind":"signal","name":"x"}}']]),
  );
  const wrapped = server as unknown as {
    validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
  };
  return { validate: (args) => wrapped.validateToolInput({}, args, 'reticle_assert') };
}

/** The shape the SDK actually throws — a serialized zod issue array. */
const ZOD_ARRAY = JSON.stringify([
  { code: 'unrecognized_keys', keys: ['selector', 'minCount'], path: ['predicate'] },
]);

const messageFor = async (args: unknown): Promise<string> => {
  try {
    await serverThatRejects(ZOD_ARRAY).validate(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected validation to reject');
};

describe('a malformed predicate over MCP', () => {
  it('is explained in a sentence, not a zod array', async () => {
    const message = await messageFor({
      predicate: { kind: PredicateKind.ELEMENT, selector: '.grid', minCount: 2 },
    });
    expect(message).toContain('did not parse');
    expect(message).toContain('element accepts');
    expect(message).not.toContain('unrecognized_keys');
  });

  it('says nothing ran, so the caller knows no verdict was produced', async () => {
    const message = await messageFor({
      predicate: { kind: PredicateKind.ELEMENT, selector: '.grid' },
    });
    expect(message).toContain('no verdict was produced');
  });

  it('covers `until`, which act_and_wait spells differently', async () => {
    const message = await messageFor({
      ref: 'e1',
      action: 'click',
      until: { kind: PredicateKind.ELEMENT, selector: '.grid' },
    });
    expect(message).toContain('element accepts');
  });

  it('leaves an unrelated failure alone rather than blaming the predicate', async () => {
    // The predicate is valid; something else about the call was not. Substituting a predicate
    // explanation here would be confidently wrong.
    const message = await messageFor({
      predicate: { kind: PredicateKind.SIGNAL, name: 'ok' },
      timeout_ms: 'soon',
    });
    expect(message).toContain('unrecognized_keys');
    expect(message).not.toContain('did not parse');
  });

  it('leaves a call with no predicate at all alone', async () => {
    const message = await messageFor({ ref: 'e1', action: 'nope' });
    expect(message).toContain('unrecognized_keys');
  });
});
