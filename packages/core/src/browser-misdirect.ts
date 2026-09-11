/**
 * Names that exist ONLY to say where the browser API actually lives.
 *
 * `@reticlehq/core` is the wire contract — zod schemas and constants, no DOM anywhere in it — but it
 * is the package whose name reads like "the thing you install", so agents and hand-written snippets
 * keep reaching for `import { install, reticle } from '@reticlehq/core'`. Reported from the field:
 * that import took a Vite app down with a blank page and `SyntaxError: The requested module does not
 * provide an export named 'install'`, which names neither the mistake nor the fix.
 *
 * Renaming the package would be worse than the problem. Exporting the names, so the module still
 * loads and the first call says where to go, costs three lines and turns a dead end into a sentence.
 */

const WRONG_PACKAGE =
  '@reticlehq/core is the wire contract (schemas + constants) and has no browser API. The SDK that ' +
  'connects a page lives in @reticlehq/browser (or @reticlehq/react, which re-exports it), and it ' +
  'is normally wired for you by @reticlehq/vite-plugin or @reticlehq/next — run `npx ' +
  '@reticlehq/server init` and let it do the wiring.';

function browserApiIsElsewhere(): never {
  throw new Error(WRONG_PACKAGE);
}

/** Not the SDK. Throws with the package that has it — see the note above. */
export const install = browserApiIsElsewhere;
/** Not the SDK. Throws with the package that has it — see the note above. */
export const connect = browserApiIsElsewhere;
/** Not the SDK instance (that is `@reticlehq/browser`'s). Every call says so. */
export const reticle = {
  connect: browserApiIsElsewhere,
  install: browserApiIsElsewhere,
} as const;
