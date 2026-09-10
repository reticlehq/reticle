/**
 * OpenReality: what a realm must be able to do, and what a verdict is allowed to say.
 *
 * Kept separate from the engine on purpose. Somebody implementing this for their own kind of
 * environment needs the rules; they do not need Reticle, and asking them to install it to read a
 * contract would say the specification and the product are the same thing.
 */
export * from './realm-interaction.js';
