// Generate JSON Schema for the Reticle wire contract from the zod schemas in @reticlehq/core.
//
// This is the multi-language linchpin: a Python / Go / Rust SDK conforms to the wire spec by
// validating against these JSON Schemas, without importing the TypeScript library. The converter
// (`zod-to-json-schema`) is a BUILD-TIME devDependency — it never ships. Only the generated
// dist/schema/*.json ships, so @reticlehq/core's runtime dependency stays `zod` only.
//
// `buildWireSchemas` is a pure function over its inputs so the parity test can call it with the
// zod schemas straight from src (no dist needed) and assert coverage + validity. The CLI entry
// (`node scripts/gen-schema.mjs`) feeds it the built dist and writes the files.

/** The wire messages that cross the browser ↔ bridge ↔ agent boundary — the conformance surface. */
export const WIRE_SCHEMA_NAMES = Object.freeze([
  'reticle-message', // the top-level discriminated union every frame is one of
  'reticle-event',
  'hello-message',
  'command-message',
  'command-result',
  'event-message',
  'event-type', // the enum of event `type` strings
  // What each event actually CONTAINS. Without this the published contract described the envelope
  // and nothing else: `data` was `{ type: "object", additionalProperties: {} }`, so an SDK in
  // another language was told an event has a type from a list and a payload of arbitrary shape.
  'event-payloads',
]);

/**
 * Build the JSON Schema map for the wire contract.
 * @param {Record<string, unknown>} core  The @reticlehq/core module namespace (zod schemas + EventType).
 * @param {(schema: unknown, name: string) => object} zodToJsonSchema  The converter.
 * @param {{ enum: (values: [string, ...string[]]) => unknown }} z  The zod namespace (for the EventType enum).
 * @returns {Record<string, object>}  name -> JSON Schema.
 */
export function buildWireSchemas(core, zodToJsonSchema, z) {
  const eventTypeValues = Object.values(core.EventType);
  const eventTypeEnum = z.enum(eventTypeValues);
  return {
    'reticle-message': zodToJsonSchema(core.ReticleMessageSchema, 'ReticleMessage'),
    'reticle-event': zodToJsonSchema(core.ReticleEventSchema, 'ReticleEvent'),
    'hello-message': zodToJsonSchema(core.HelloMessageSchema, 'HelloMessage'),
    'command-message': zodToJsonSchema(core.CommandMessageSchema, 'CommandMessage'),
    'command-result': zodToJsonSchema(core.CommandResultSchema, 'CommandResult'),
    'event-message': zodToJsonSchema(core.EventMessageSchema, 'EventMessage'),
    'event-type': zodToJsonSchema(eventTypeEnum, 'EventType'),
    'event-payloads': buildEventPayloadSchema(core, zodToJsonSchema),
  };
}

/**
 * One document mapping every event `type` to the shape of its `data`.
 *
 * Kept as a map rather than folded into `reticle-event.json` as a discriminated union on purpose:
 * the union form makes a single enormous schema whose error messages, when a payload is wrong, name
 * the whole union rather than the one event that failed. A reader implementing `page.health` wants
 * to look up `page.health`, and a validator reporting on it should say so.
 *
 * @param {Record<string, unknown>} core  The @reticlehq/core module namespace.
 * @param {(schema: unknown, name?: string) => object} zodToJsonSchema  The converter.
 * @returns {object}  A JSON Schema object whose `properties` are keyed by event type.
 */
export function buildEventPayloadSchema(core, zodToJsonSchema) {
  const properties = {};
  for (const [type, schema] of Object.entries(core.EVENT_PAYLOAD_SCHEMAS)) {
    properties[type] = zodToJsonSchema(schema);
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'EventPayloads',
    description:
      'The shape of `data` for each Reticle event type. Look up an event by its `type` string. ' +
      'Every payload allows unknown keys, so a newer SDK can add a field without failing an older ' +
      'reader; a field being absent here means this version never described it, not that sending it ' +
      'is an error.',
    type: 'object',
    properties,
  };
}

// CLI entry: only when run directly (not when imported by the parity test).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const core = await import('../dist/index.js');
  const { zodToJsonSchema } = await import('zod-to-json-schema');
  const { z } = await import('zod');

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'dist', 'schema');
  await mkdir(outDir, { recursive: true });

  const schemas = buildWireSchemas(core, zodToJsonSchema, z);
  for (const [name, schema] of Object.entries(schemas)) {
    await writeFile(join(outDir, `${name}.json`), JSON.stringify(schema, null, 2) + '\n');
  }
  // stderr, not stdout. This runs inside `prepack`, so anything it prints on stdout is prepended to
  // the output of whatever invoked the pack — `npm pack --json` becomes unparseable, which is how
  // you would script a tarball size check or a supply-chain audit. Progress is diagnostics; the
  // artifact is the product.
  process.stderr.write(
    `wrote ${String(Object.keys(schemas).length)} wire schemas to dist/schema/\n`,
  );
}
