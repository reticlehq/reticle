import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
// The generator is build-time tooling (not shipped); the test drives the same pure function so the
// JSON Schemas can never drift from the zod source of truth.
import { buildWireSchemas, WIRE_SCHEMA_NAMES } from '../scripts/gen-schema.mjs';
import * as core from './index.js';

// The generator is untyped build tooling; cross the boundary explicitly. zodToJsonSchema wants a
// concrete ZodType, which the generator supplies at runtime from the core module namespace.
const convert = zodToJsonSchema as unknown as (schema: unknown, name: string) => object;
const schemas = buildWireSchemas(core, convert, z);

describe('wire-contract JSON Schema', () => {
  it('emits exactly the declared set of wire schemas', () => {
    expect(Object.keys(schemas).sort()).toEqual([...WIRE_SCHEMA_NAMES].sort());
  });

  it('every wire schema is a non-empty JSON Schema object', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema, name).toBeTypeOf('object');
      // zod-to-json-schema wraps named schemas as { $ref, definitions } — both keys prove real output.
      expect(Object.keys(schema).length, name).toBeGreaterThan(0);
    }
  });

  it('covers every EventType value so a new event cannot ship without a schema entry', () => {
    // Pull the enum out of the generated event-type schema (through its $ref into definitions).
    const emitted = JSON.stringify(schemas['event-type']);
    for (const value of Object.values(core.EventType)) {
      expect(emitted, `EventType ${value} missing from the JSON Schema enum`).toContain(
        `"${value}"`,
      );
    }
  });

  it('reticle-message models the full command/event/hello union', () => {
    // The top-level frame is a discriminated union — its JSON Schema must offer multiple branches.
    const json = JSON.stringify(schemas['reticle-message']);
    expect(json).toContain('anyOf');
  });
});
