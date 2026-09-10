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
  /**
   * The contract published the names of everything the app SAYS and none of what it can be ASKED.
   *
   * `event-type.json` lists every event name, so a reader knows what can arrive. There was no
   * equivalent for commands, so the same reader could not discover that `snapshot`, `query` or `act`
   * exist at all -- the half of the contract that drives the app was anonymous.
   *
   * Names only. What each command CARRIES is a separate and larger job: those shapes live implicitly
   * in sixteen handlers that pick fields out of an untyped `args` bag, and inventing schemas for them
   * from the outside would be guessing at a wire contract. Publishing the names is the part that is
   * certain today.
   */
  it('publishes the command names, the way it already publishes event names', () => {
    const emitted = JSON.stringify((schemas as Record<string, unknown>)['command-name']);
    expect(emitted, 'no command-name schema is generated').toBeDefined();
    for (const value of Object.values(core.ReticleCommand)) {
      expect(emitted, `command ${String(value)} missing from the published enum`).toContain(
        `"${String(value)}"`,
      );
    }
  });

  /**
   * The published contract has to describe what an event CONTAINS, not just that it has some.
   *
   * `reticle-event.json` was 1,317 bytes and its payload read
   * `data: { type: "object", additionalProperties: {} }` -- "an object, any keys". So a Python, Go or
   * Rust SDK validating against these files was told an event has a `type` from a list and a `data`
   * object of arbitrary shape, and could not construct a valid `page.health`, `net` or `dom` payload
   * from the contract at all.
   *
   * That matters twice over. It is the multi-language promise this generator's own header makes, and
   * it is the foundation the conformance kit is designed on: a runner that validates against these
   * schemas and nothing else is only as strong as what they describe.
   */
  it('publishes a payload schema for every event type, not just the envelope', () => {
    const payloads = (schemas as Record<string, unknown>)['event-payloads'] as {
      properties?: Record<string, unknown>;
    };
    expect(payloads, 'no event-payloads schema is generated').toBeDefined();
    const described = Object.keys(payloads.properties ?? {});
    for (const type of Object.values(core.EventType)) {
      expect(described, `event ${String(type)} has no published payload schema`).toContain(type);
    }
  });

  it('the published payload schema names the fields the server depends on', () => {
    const json = JSON.stringify((schemas as Record<string, unknown>)['event-payloads']);
    // `runtime` is the realm the page reports. The server reads it; until it was declared it rode
    // an untyped passthrough and appeared in none of the generated files.
    expect(json).toContain('runtime');
  });

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

describe('bridgeWsUrl — the one bridge-URL builder', () => {
  it('composes host, port, and the ws path; defaults to localhost + the default port', () => {
    expect(core.bridgeWsUrl(58432)).toBe(`ws://localhost:58432${core.RETICLE_WS_PATH}`);
    expect(core.bridgeWsUrl()).toBe(
      `ws://localhost:${String(core.RETICLE_DEFAULT_PORT)}${core.RETICLE_WS_PATH}`,
    );
    expect(core.bridgeWsUrl(4400, '127.0.0.1')).toBe(`ws://127.0.0.1:4400${core.RETICLE_WS_PATH}`);
  });
});
