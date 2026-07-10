// Types for the build-time JSON Schema generator (gen-schema.mjs), so the parity test in src/ can
// import it under strict TypeScript without pulling the generator into the shipped build.

export const WIRE_SCHEMA_NAMES: readonly string[];

export function buildWireSchemas(
  core: Record<string, unknown>,
  zodToJsonSchema: (schema: unknown, name: string) => object,
  z: { enum: (values: [string, ...string[]]) => unknown },
): Record<string, object>;
