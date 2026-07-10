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
  console.log('wrote %d wire schemas to dist/schema/', Object.keys(schemas).length);
}
