/**
 * The Harness's driver names.
 *
 * A leaf module on purpose: the tool table reads these while the tool surface is still loading, and
 * a module that imports nothing cannot be read half-initialised.
 *
 * There is one driver. Every Harness decision, its models and its planning run on the Reticle
 * platform, on the workspace's monthly Harness runs; this machine executes what it is told.
 */

/** The platform's Harness: it decides on its side, this machine executes. See server-driver.ts. */
export const SERVER_DRIVER = 'server';

/** An injected driver: not selectable, because only a caller in-process can supply one. */
export const CUSTOM_DRIVER_NAME = 'custom';

/** What a drive needs, said once for every place that tells somebody. */
export const EXPLORE_NEEDS =
  'Runs on the Reticle platform: needs a linked project (`reticle connect`); Free has monthly runs.';
