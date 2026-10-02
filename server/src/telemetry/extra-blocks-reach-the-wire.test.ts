/**
 * A declared telemetry block must actually reach the wire.
 *
 * Adding one means editing FOUR hand-maintained lists that nothing keeps in step: the core wire
 * schema, the event-building spread, the destructure, and the `blocks` prefix map. Miss any one and
 * the block is silently dropped — the event still fires, still validates, still arrives, and carries
 * none of the fields it exists to carry.
 *
 * That is exactly what happened to `app_instrumented` on its first day: the reporter was correct,
 * the unit test for it passed, the event landed at a real capture endpoint — with only the base
 * envelope on it. It was caught by connecting a real session to a real daemon and reading the
 * captured payload, because every layer in between was individually fine.
 *
 * So this asserts the property that actually matters and cannot be satisfied by a partial wiring:
 * for every optional block on the extra contract, emitting it produces `<block>_<field>` properties.
 * A new block with no wiring fails here rather than in six months' worth of missing data.
 */

import { describe, expect, it } from 'vitest';
import { InstallSource, TelemetryEventKind } from '@reticlehq/core/telemetry';
import { createTelemetry, type TelemetryExtra } from './telemetry.js';
import { TelemetryEventSchema } from '@reticlehq/core/telemetry';

const TEST_ENV = {
  RETICLE_TELEMETRY_KEY: 'phc_test',
  RETICLE_TELEMETRY_URL: 'http://example.test',
};

/** Outside this repo: a source checkout disables telemetry, correctly. */
const USER_PROJECT = '/tmp/some-user-app';

interface CapturedBatch {
  batch: Array<{ event: string; properties: Record<string, unknown> }>;
}

function recordingFetch(): {
  impl: typeof fetch;
  properties: () => Record<string, unknown>;
} {
  const calls: CapturedBatch[] = [];
  const impl = ((_url: string, init: { body?: string }) => {
    calls.push(JSON.parse(init.body ?? '{}') as CapturedBatch);
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, properties: () => calls[0]?.batch[0]?.properties ?? {} };
}

/**
 * One representative value per block, keyed by the field name the emitter must prefix.
 *
 * Listed here rather than derived because a zod schema cannot be inverted into a sample — but the
 * TEST is the guard: a block absent from this map is a block nobody proved reaches the wire, and the
 * completeness check below fails when the contract grows past it.
 */
/**
 * Every OBJECT block the wire schema declares, read from the schema itself.
 *
 * `SAMPLES` below is hand-maintained, and a hand-maintained list is what this whole file exists to
 * defend against — its own comment admits it ("a block absent from this map is a block nobody proved
 * reaches the wire") while nothing made it complete. So it was the SEVENTH list, and it failed the
 * same way the other six can: `onboarding` was added to the schema, the destructure and the blocks
 * map, missed in the event-building spread, and this suite stayed green at 8/8 while the event
 * landed at a real endpoint carrying only the envelope — the exact `app_instrumented` story in the
 * header above, repeated.
 *
 * Derived instead. A block added to the schema with no sample now fails HERE, naming itself.
 */
/**
 * Blocks whose WIRE prefix is not their schema key.
 *
 * One entry, and it is deliberate rather than a bug: `versionChange` flattens under `version_`, so
 * the wire reads `version_from` / `version_to`. Recorded here rather than silently special-cased,
 * because the derived check below would otherwise report a real rename as broken wiring — and the
 * next person would "fix" a prefix that six months of dashboards are already querying.
 *
 * Worth knowing while reading a payload: the envelope also carries a scalar `version`, so `version`
 * and `version_*` share a namespace by coincidence of that rename.
 */
const WIRE_PREFIX: Readonly<Record<string, string>> = { versionChange: 'version' };

function declaredObjectBlocks(): string[] {
  const shape = TelemetryEventSchema.shape as Record<string, { _def?: { typeName?: string } }>;
  return Object.entries(shape)
    .filter(([, field]) => {
      // Unwrap ZodOptional to see what it wraps; only object blocks go through the `blocks` map.
      const inner = (field as { _def?: { innerType?: { _def?: { typeName?: string } } } })._def
        ?.innerType;
      return 'ZodObject' === inner?._def?.typeName;
    })
    .map(([name]) => name);
}

const SAMPLES: Record<string, Record<string, unknown>> = {
  instrumentation: { initialized: true, agentAttached: false, msToFirstApp: 42 },
  connection: { reconnect: false, daemonAgeMs: 10 },
  outage: { stage: 'first', reason: 'sse_ended', attempts: 1 },
  init: { ok: true },
  // The nine below were absent, and absence here means nothing ever proved they reach the wire.
  // Added when the derived check above was introduced; `onboarding` was genuinely broken when they
  // were, which is the whole argument for deriving the list rather than maintaining it.
  feedback: { source: 'cli', kind: 'bug' },
  session: { durationMs: 1200, toolCalls: 3 },
  project: { stack: 'vite', stackSource: 'config' },
  verification: { via: 'tool', verified: 'yes' },
  versionChange: { from: '3.0.0', to: '3.1.0' },
  crash: { kind: 'daemon', errorType: 'Error' },
  identity: { context: 'company' },
  onboarding: { phase: 'first_run', step: 'verdict_produced', status: 'completed' },
  refusal: { tool: 'reticle_act', reason: 'no_session' },
  bug: { kind: 'element.absent', source: 'assertion', tool: 'reticle_assert' },
};

async function propertiesFor(extra: TelemetryExtra): Promise<Record<string, unknown>> {
  const { impl, properties } = recordingFetch();
  const telemetry = createTelemetry({
    version: '9.9.9',
    env: { ...TEST_ENV, RETICLE_TELEMETRY: '1' },
    fetchImpl: impl,
    cwd: USER_PROJECT,
  });
  await telemetry.emit(TelemetryEventKind.APP_INSTRUMENTED, extra);
  return properties();
}

describe('every declared block survives to the wire', () => {
  it('has a sample for EVERY object block the wire schema declares', () => {
    const missing = declaredObjectBlocks().filter((b) => SAMPLES[b] === undefined);
    expect(
      missing,
      `these blocks are declared on the wire schema and nothing here proves they reach the wire: ` +
        `${missing.join(', ')}. Add a sample — a block with no sample is a block that can be wired ` +
        `into three of the five lists and silently carry nothing, which is what happened to ` +
        `app_instrumented and again to onboarding.`,
    ).toEqual([]);
  });

  for (const [block, sample] of Object.entries(SAMPLES)) {
    it(`${block} arrives as ${WIRE_PREFIX[block] ?? block}_* properties`, async () => {
      const properties = await propertiesFor({ [block]: sample });
      const prefix = WIRE_PREFIX[block] ?? block;
      for (const field of Object.keys(sample)) {
        expect(properties, `${prefix}_${field} was dropped`).toHaveProperty(`${prefix}_${field}`);
      }
    });
  }

  it('carries the values, not merely the keys', async () => {
    const properties = await propertiesFor({
      instrumentation: { initialized: true, agentAttached: false, msToFirstApp: 42 },
    });
    expect(properties['instrumentation_initialized']).toBe(true);
    // `false` is the value most likely to be lost to a truthiness check somewhere in the chain, and
    // "an agent was NOT attached when the app arrived" is a fact this event exists to report.
    expect(properties['instrumentation_agentAttached']).toBe(false);
    expect(properties['instrumentation_msToFirstApp']).toBe(42);
  });

  /**
   * A SCALAR extra skips the `blocks` map (there is nothing to flatten) and so skips the one wiring
   * step this file was written about — which makes it look safer than it is. It still needs the
   * event-building spread and the core wire schema, and missing either drops it exactly as silently.
   */
  it('carries a scalar extra, which has no block to be flattened out of', async () => {
    const properties = await propertiesFor({ installSource: InstallSource.PLUGIN });
    expect(properties['installSource']).toBe(InstallSource.PLUGIN);
  });

  it('never nests a block, which would make it invisible to a breakdown', async () => {
    const properties = await propertiesFor({
      instrumentation: { initialized: true, agentAttached: true, msToFirstApp: 1 },
    });
    expect(properties['instrumentation']).toBeUndefined();
  });
});
