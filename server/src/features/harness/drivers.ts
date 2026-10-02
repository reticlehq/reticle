/**
 * The names of the drivers the harness can be asked for.
 *
 * A leaf module on purpose. These used to be re-exported from `harness-explore.ts`, which sits in
 * the tool surface and is reached, through the toolset and the tool table, from the very tool that
 * needs to declare them as an enum — a cycle that left the list `[undefined, undefined]` at the
 * moment zod read it, and failed inside a JSON-schema parser rather than anywhere near the cause.
 * Nothing here imports anything, so nothing can be half-initialised when it is read.
 */

/** Generates its tool calls as text, and names the journeys it records. The default. */
export const ANTHROPIC_DRIVER_NAME = 'anthropic';

/** Answers typed questions; picks from the elements on the page and cannot invent one. */
export const JEV_DRIVER_NAME = 'jev';

/** Generates its tool calls, over Chat Completions. Here so an A/B has a third arm. */
export const OPENAI_DRIVER_NAME = 'openai';

/** What a caller may name. Order is the order a reader sees them in the tool description. */
export const DRIVER_NAMES = [ANTHROPIC_DRIVER_NAME, JEV_DRIVER_NAME, OPENAI_DRIVER_NAME] as const;

/** An injected driver: not selectable, because only a caller in-process can supply one. */
export const CUSTOM_DRIVER_NAME = 'custom';
