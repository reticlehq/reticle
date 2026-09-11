import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Verified } from '@reticlehq/core';
import { VERIFY_CHANGE_TOOLS } from './verify-change-tools.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import type { ToolDeps } from '../tools/tools.js';

const tool = VERIFY_CHANGE_TOOLS[0];
if (tool === undefined) throw new Error('reticle_verify_change is not defined');

/** Deps whose flow store is empty — nothing on disk covers anything. */
const depsWithNoFlows = (): ToolDeps =>
  ({
    fs: {
      exists: () => Promise.resolve(false),
      readDir: () => Promise.resolve([]),
      readFile: () => Promise.resolve(undefined),
      writeFile: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
    },
    reticleRoot: '/tmp/nonexistent-reticle-root',
    flows: { list: () => Promise.resolve([]) },
  }) as unknown as ToolDeps;

describe('reticle_verify_change — an uncovered change is never a pass', () => {
  /**
   * The property the whole tool exists to protect. "Nothing ran" and "everything passed" are the
   * same green to anyone reading a boolean, and reporting a change as verified on the strength of
   * having executed nothing is precisely the false green this project exists to remove.
   */
  it('says UNKNOWN — not YES — when no saved flow covers the changed files', async () => {
    const result = (await tool.handler(depsWithNoFlows(), {
      files: ['src/Untouched.tsx'],
    })) as Record<string, unknown>;

    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(result['verified']).not.toBe(Verified.YES);
    expect(String(result['because'])).toContain('no saved flow covers');
    expect(result['flowsRun']).toEqual([]);
  });

  it('tells the caller how to fix the gap rather than just naming it', async () => {
    const result = (await tool.handler(depsWithNoFlows(), { files: ['src/A.tsx'] })) as Record<
      string,
      unknown
    >;
    expect(String(result['because'])).toMatch(/reticle_flow_save|driving the app/);
  });

  it('says UNKNOWN when no files were given, instead of verifying nothing', async () => {
    const result = (await tool.handler(depsWithNoFlows(), {})) as Record<string, unknown>;
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(String(result['because'])).toContain('nothing to decide');
  });
});

describe('reticle_verify_change — it delegates rather than reimplements', () => {
  const withFlows = (suite: Record<string, unknown>): ToolDeps => {
    const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
    if (verify === undefined) throw new Error('flow_verify missing');
    vi.spyOn(verify, 'handler').mockResolvedValue(suite);
    return depsWithNoFlows();
  };

  /**
   * The suite verdict must come from `reticle_flow_verify` itself. A second replay implementation
   * would be free to drift from the one the CLI and the e2e battery exercise, and the drift would
   * surface as two different answers to the same question.
   */
  it('reports NO when the covering flows failed', async () => {
    const deps = withFlows({ status: 'fail', total: 3, passed: 2, failed: 1 });
    // Force one affected flow by pretending provenance is unknown for a saved flow.
    const spy = vi
      .spyOn(await import('./flow-sources.js'), 'affectedSavedFlows')
      .mockReturnValue({ affected: ['checkout'], unknownProvenance: [] });

    const result = (await tool.handler(deps, { files: ['src/Checkout.tsx'] })) as Record<
      string,
      unknown
    >;
    expect(result['verified']).toBe(Verified.NO);
    expect(String(result['because'])).toContain('1 of 3');
    spy.mockRestore();
  });

  it('reports YES only when every covering flow passed', async () => {
    const deps = withFlows({ status: 'pass', total: 2, passed: 2, failed: 0 });
    const spy = vi
      .spyOn(await import('./flow-sources.js'), 'affectedSavedFlows')
      .mockReturnValue({ affected: ['checkout', 'login'], unknownProvenance: [] });

    const result = (await tool.handler(deps, { files: ['src/Checkout.tsx'] })) as Record<
      string,
      unknown
    >;
    expect(result['verified']).toBe(Verified.YES);
    expect(result['flowsRun']).toEqual(['checkout', 'login']);
    spy.mockRestore();
  });

  /**
   * A flow re-run only because Reticle cannot tell what it covers is weaker evidence than one that
   * demonstrably touches the change. Saying so keeps a green from reading stronger than it is.
   */
  it('discloses when flows were included only for unknown provenance', async () => {
    const deps = withFlows({ status: 'pass', total: 1, passed: 1, failed: 0 });
    const spy = vi
      .spyOn(await import('./flow-sources.js'), 'affectedSavedFlows')
      .mockReturnValue({ affected: ['legacy'], unknownProvenance: ['legacy'] });

    const result = (await tool.handler(deps, { files: ['src/A.tsx'] })) as Record<string, unknown>;
    expect(String(result['because'])).toContain('cannot tell');
    spy.mockRestore();
  });
});

/**
 * A suite that goes green while a channel disagrees is the exact false green this product exists to
 * catch, and a regression replay is where it is most likely to hide: the flow was recorded when the
 * app worked, so it still "passes" while the write underneath it fails.
 */
describe('reticle_verify_change — a green suite is not the end of the check', () => {
  const sessionWith = (events: unknown[], tree: string, acted: string[]): ToolDeps =>
    ({
      ...depsWithNoFlows(),
      sessions: {
        resolve: () => ({
          elapsed: () => 0,
          eventsSince: () => events,
          actedRefs: () => new Set(acted),
          command: () => Promise.resolve({ ok: true, result: { tree } }),
        }),
      },
    }) as unknown as ToolDeps;

  const passingSuite = { status: 'pass', total: 1, passed: 1, failed: 0 };

  it('reports NO when a contradiction appeared during a passing replay', async () => {
    const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
    if (verify === undefined) throw new Error('flow_verify missing');
    vi.spyOn(verify, 'handler').mockResolvedValue(passingSuite);
    const affectedSpy = vi
      .spyOn(await import('./flow-sources.js'), 'affectedSavedFlows')
      .mockReturnValue({ affected: ['checkout'], unknownProvenance: [] });
    const contradictionSpy = vi
      .spyOn(await import('../events/contradictions.js'), 'findContradictions')
      .mockReturnValue([{ kind: 'ui-advanced-request-failed' }] as never);

    const result = (await tool.handler(sessionWith([], '', []), {
      files: ['src/Checkout.tsx'],
    })) as Record<string, unknown>;

    expect(result['verified']).toBe(Verified.NO);
    expect(String(result['because'])).toContain('ui-advanced-request-failed');
    affectedSpy.mockRestore();
    contradictionSpy.mockRestore();
  });

  it('reports which controls the covering flows never drove', async () => {
    const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
    if (verify === undefined) throw new Error('flow_verify missing');
    vi.spyOn(verify, 'handler').mockResolvedValue(passingSuite);
    const affectedSpy = vi
      .spyOn(await import('./flow-sources.js'), 'affectedSavedFlows')
      .mockReturnValue({ affected: ['checkout'], unknownProvenance: [] });

    const tree = '- button "Pay" (ref=e1)\n- button "Cancel" (ref=e2)';
    const result = (await tool.handler(sessionWith([], tree, ['e1']), {
      files: ['src/Checkout.tsx'],
    })) as Record<string, unknown>;

    expect(result['verified']).toBe(Verified.YES);
    expect(result['untouched']).toEqual([{ ref: 'e2', label: 'button "Cancel"' }]);
    affectedSpy.mockRestore();
  });

  /**
   * The trap this field exists for: with `parallel`, flows run in leased contexts, so the events and
   * driven refs on the resolved session belong to something else. Reporting "no contradictions" from
   * the wrong session would be a false green manufactured by the false-green detector, so an absent
   * `contradictions` means "none found" ONLY when `measured` says it was looked for.
   */
  it('says what it measured, so an absent finding is never read as a clean result', async () => {
    const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
    if (verify === undefined) throw new Error('flow_verify missing');
    vi.spyOn(verify, 'handler').mockResolvedValue(passingSuite);
    const affectedSpy = vi
      .spyOn(await import('./flow-sources.js'), 'affectedSavedFlows')
      .mockReturnValue({ affected: ['checkout'], unknownProvenance: [] });

    const parallelRun = (await tool.handler(sessionWith([], '', []), {
      files: ['src/Checkout.tsx'],
      parallel: 4,
    })) as Record<string, unknown>;
    expect(parallelRun['measured']).toEqual(['flows']);
    expect(parallelRun['contradictions']).toBeUndefined();

    const sequentialRun = (await tool.handler(sessionWith([], '', []), {
      files: ['src/Checkout.tsx'],
    })) as Record<string, unknown>;
    expect(sequentialRun['measured']).toContain('contradictions');
    affectedSpy.mockRestore();
  });
});

/**
 * The tool's own DECLARED output schema, applied to what the handler actually returns.
 *
 * Every test above calls the handler directly, which is exactly why they all passed while the tool
 * was broken over MCP: the schema is enforced by the MCP layer, not by the handler, so a direct
 * call never sees it. Measured against a real `reticle mcp` process driving a real app,
 * `reticle_verify_change {}` came back `-32602 Output validation error: measured Required` — the
 * two UNKNOWN returns omitted a field the schema marks required.
 *
 * Those two are the COMMON paths, not edge cases: "no files given" and "no saved flow covers this
 * change". So the careful UNKNOWN verdict — the one this whole tool exists to deliver — was
 * replaced by a protocol error for every caller who had not already recorded a covering flow.
 */
describe('what the handler returns satisfies the output schema it advertises', () => {
  const outputShape = z.object(tool.outputSchema as Record<string, z.ZodTypeAny>);

  it('the no-files UNKNOWN return validates', async () => {
    const result = await tool.handler(depsWithNoFlows(), {});
    expect(() => outputShape.parse(result)).not.toThrow();
  });

  it('the no-covering-flow UNKNOWN return validates', async () => {
    const result = await tool.handler(depsWithNoFlows(), { files: ['src/Untouched.tsx'] });
    expect(() => outputShape.parse(result)).not.toThrow();
  });

  it('and `measured` is empty on both, because nothing was looked for', async () => {
    const none = (await tool.handler(depsWithNoFlows(), {})) as Record<string, unknown>;
    const uncovered = (await tool.handler(depsWithNoFlows(), {
      files: ['src/Untouched.tsx'],
    })) as Record<string, unknown>;
    expect(none['measured']).toEqual([]);
    expect(uncovered['measured']).toEqual([]);
  });
});
