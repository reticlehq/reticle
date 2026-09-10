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
const SAMPLES: Record<string, Record<string, unknown>> = {
  instrumentation: { initialized: true, agentAttached: false, msToFirstApp: 42 },
  connection: { reconnect: false, daemonAgeMs: 10 },
  outage: { stage: 'first', reason: 'sse_ended', attempts: 1 },
  init: { ok: true },
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
  for (const [block, sample] of Object.entries(SAMPLES)) {
    it(`${block} arrives as ${block}_* properties`, async () => {
      const properties = await propertiesFor({ [block]: sample });
      for (const field of Object.keys(sample)) {
        expect(properties, `${block}_${field} was dropped`).toHaveProperty(`${block}_${field}`);
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
