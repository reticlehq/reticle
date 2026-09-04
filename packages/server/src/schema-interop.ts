import type {
  ZodType,
  AnyZodObject,
  ZodDefault,
  ZodEffects,
  ZodLiteral,
  ZodNullable,
  ZodOptional,
} from 'zod';

/**
 * `@reticlehq/core` and `@reticlehq/server` intentionally pin different `zod` versions: core is
 * capped below 3.23.0 so the browser SDK's transitive dependency tree stays parseable by webpack 4
 * (see `legacy-syntax-guard.test.ts`), while server floats to satisfy `@modelcontextprotocol/sdk`'s
 * newer peer range. Each version is a SEPARATE installed copy of the `zod` package, so a schema
 * core built is an instance of core's `ZodObject` class, not server's — two distinct classes with
 * the same name, one per module instance. `.parse`/`.safeParse`/`.extend` are plain method calls
 * and work identically either way, so most server code never notices. `instanceof` does not: it
 * compares prototypes, and `coreSchema instanceof serverZod.ZodObject` is `false` even though the
 * schema is a real, working ZodObject. `nestedKeysOf`'s schema-shape introspection hit exactly this
 * — a core-built `ElementQuerySchema` silently failed its `instanceof z.ZodObject` check and
 * reported no nested fields. `isZodObject`/`isZodOptional` below duck-type on zod's own internal
 * `_def.typeName` tag (the same value in every zod 3.x build) instead, for exactly this class of
 * check.
 *
 * `asServerZodObject`/`asServerZodType` re-type a core-built schema as server's own zod type at the
 * few points server COMPOSES one (`.extend()`, `z.array()`, a generic `ZodTypeAny` parameter) —
 * TypeScript treats the two classes as structurally incompatible once a newer zod adds fields
 * (`~standard`/`~validate`) an older one lacks. These casts change only the type server code sees;
 * the object is identical. They do NOT fix `instanceof` — that needs the duck-typed checks instead.
 */
export function asServerZodObject(schema: object): AnyZodObject {
  return schema as AnyZodObject;
}

/**
 * Explicit `Output` (never inferred) so the bridge keeps its caller's concrete type — e.g.
 * `asServerZodType<JournalAction>(JournalActionSchema)` — instead of collapsing to `ZodTypeAny`'s
 * own `any`, which would erase type-checking on everything downstream of the cast.
 */
export function asServerZodType<Output>(schema: object): ZodType<Output> {
  return schema as unknown as ZodType<Output>;
}

/** A zod internal `_def` carries a `typeName` tag naming its constructor — stable across builds. */
function zodTypeName(schema: unknown): string | undefined {
  if ('object' !== typeof schema || null === schema) return undefined;
  const def = (schema as { _def?: unknown })._def;
  if ('object' !== typeof def || null === def) return undefined;
  const typeName = (def as { typeName?: unknown }).typeName;
  return 'string' === typeof typeName ? typeName : undefined;
}

/**
 * `schema instanceof z.ZodObject`, but true for a `ZodObject` built by ANY zod 3.x module instance
 * — including core's. Use this (not `instanceof`) for any check that might see a core-built schema.
 */
export function isZodObject(schema: unknown): schema is AnyZodObject {
  return 'ZodObject' === zodTypeName(schema);
}

/** `schema instanceof z.ZodOptional`, cross-zod-instance safe — see `isZodObject`. */
export function isZodOptional(schema: unknown): schema is ZodOptional<ZodType> {
  return 'ZodOptional' === zodTypeName(schema);
}

/** `schema instanceof z.ZodNullable`, cross-zod-instance safe — see `isZodObject`. */
export function isZodNullable(schema: unknown): schema is ZodNullable<ZodType> {
  return 'ZodNullable' === zodTypeName(schema);
}

/** `schema instanceof z.ZodDefault`, cross-zod-instance safe — see `isZodObject`. */
export function isZodDefault(schema: unknown): schema is ZodDefault<ZodType> {
  return 'ZodDefault' === zodTypeName(schema);
}

/** `schema instanceof z.ZodEffects`, cross-zod-instance safe — see `isZodObject`. */
export function isZodEffects(schema: unknown): schema is ZodEffects<ZodType> {
  return 'ZodEffects' === zodTypeName(schema);
}

/** `schema instanceof z.ZodLiteral`, cross-zod-instance safe — see `isZodObject`. */
export function isZodLiteral(schema: unknown): schema is ZodLiteral<unknown> {
  return 'ZodLiteral' === zodTypeName(schema);
}
