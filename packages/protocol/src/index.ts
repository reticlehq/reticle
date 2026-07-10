/**
 * @deprecated `@reticlehq/protocol` has moved. The wire contract — types, zod schemas, constants,
 * messages, security helpers, and the isomorphic kernel — now lives in `@reticlehq/core`, the
 * bottom-of-graph foundation every Reticle package imports.
 *
 * This package is a thin alias kept for one major version so existing installs keep working. It will
 * be removed in v3. Migrate imports:
 *
 *   - import { EventType } from '@reticlehq/protocol';  // old
 *   + import { EventType } from '@reticlehq/core';      // new
 *
 * See MIGRATION.md.
 */
export * from '@reticlehq/core';
