/**
 * Types for the JSON Schema generator, so the guard beside it can import it without an implicit
 * `any`.
 *
 * The generator is plain ESM because it runs as a build step and has no package of its own. The
 * guard (`src/schema-covers-vocabulary.test.ts`) reads the same `SCHEMAS` map the generator
 * writes from, deliberately: a second list of "what the contract contains" is exactly the drift
 * it exists to catch.
 */

import type { ZodTypeAny } from 'zod';

/** Every schema published as JSON, keyed by the file name it is written to. */
export const SCHEMAS: Readonly<Record<string, ZodTypeAny>>;

/** The generated JSON Schemas, keyed the same way. Each carries an `$id`. */
export function buildSchemas(
  schemas?: Readonly<Record<string, ZodTypeAny>>,
): Record<string, { $id: string } & Record<string, unknown>>;
