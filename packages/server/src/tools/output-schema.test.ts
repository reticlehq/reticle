/**
 * An outputSchema that describes nothing the tool returns.
 *
 * `reticle_clock` declared `{ ok?, elapsed? }`. The browser command returns `{ frozen }`. Neither
 * declared field exists, and MCP strips undeclared fields from `structuredContent` — so a successful
 * freeze and a failed one both validated to `{}`, and a caller reading structuredContent could not
 * tell them apart. Reported from a field sweep under the `full` profile, where output schemas are sent.
 *
 * The general rule this pins: a declared output field must be one the tool can actually produce. A
 * schema whose keys never appear is worse than no schema, because it silently erases the answer.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';

const schemaOf = (name: string): Record<string, unknown> | undefined =>
  TOOLS.find((t) => t.name === name)?.outputSchema;

describe('reticle_clock output', () => {
  it('declares the field it actually returns', () => {
    const schema = schemaOf(ReticleTool.CLOCK);
    expect(schema).toBeDefined();
    expect(Object.keys(schema ?? {})).toContain('frozen');
  });

  it('no longer declares fields the command never produces', () => {
    // `ok` and `elapsed` come from no clock code path; declaring them stripped the real answer.
    expect(Object.keys(schemaOf(ReticleTool.CLOCK) ?? {})).not.toContain('elapsed');
  });
});

/**
 * A hint field the browser emits and the schema does not declare is silently dropped.
 *
 * This exact loss has happened twice on this one object. `presentRegions` was emitted by the browser
 * and undeclared here, so the successor field was invisible on every zero-match result while its
 * deprecated predecessor was the only thing an agent could see; the second version of the fix then
 * omitted `sample` and repeated the sin one level down.
 *
 * `nameNearMiss` is the third field on the same object, added because a role+name query is exact and
 * a miss used to say nothing about the label the caller was one word away from. It is pinned here
 * rather than trusted, because the failure is silent by construction: nothing throws, no test
 * reddens, and the data is simply not there.
 */
describe('the zero-match hint declares everything the browser puts in it', () => {
  /** The declared keys of the `hint` object, through zod's optional() wrapper. */
  const hintShape = (): string[] => {
    const hint = schemaOf(ReticleTool.QUERY)?.['hint'];
    const parsed = z.object({ hint: hint as z.ZodTypeAny }).safeParse({
      hint: {
        route: '/x',
        presentRegions: [],
        presentTestids: [],
        knownEmptyState: false,
        splitText: { ref: 'e1' },
        nameNearMiss: ['2 Mesh'],
      },
    });
    expect(parsed.success).toBe(true);
    return Object.keys(parsed.success ? (parsed.data.hint as Record<string, unknown>) : {});
  };

  // Parsed, not introspected: zod STRIPS what it does not declare, so a field that survives a parse
  // is a field an agent will actually see. Reading the schema object would pass on a declaration
  // that is present but shaped wrong, which is the failure mode `sample` had.
  it.each(['route', 'presentRegions', 'knownEmptyState', 'splitText', 'nameNearMiss'])(
    'passes %s through instead of stripping it',
    (field) => {
      expect(hintShape()).toContain(field);
    },
  );
});
