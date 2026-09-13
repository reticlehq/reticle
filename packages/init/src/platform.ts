/**
 * The `process.platform` values this daemon actually branches on, named once.
 *
 * They were spelled inline in five files — `cli-launch`, `cloud-cli`, `init/node-io`, `update/updater`
 * — and every one of them gates real behaviour rather than cosmetics: whether a spawn needs a shell,
 * whether the npm binary is `npm.cmd`, which command opens a browser. A typo in any of those reads as
 * "Windows is broken" and is invisible on the machine of whoever wrote it, because the wrong branch
 * simply never runs there.
 *
 * Node-side only, so deliberately NOT in `@reticlehq/core` — core is the wire contract, and a
 * platform name never crosses the wire.
 */
export const NodePlatform = {
  WINDOWS: 'win32',
  MACOS: 'darwin',
} as const;
