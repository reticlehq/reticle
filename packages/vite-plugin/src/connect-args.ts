import { RETICLE_DEFAULT_PORT, bridgeWsUrl } from '@reticlehq/core';

import type { ReticleVitePluginOptions } from './index.js';

/** Build the `reticle.connect` argument literal — only includes keys the user set. */
export function connectArgs(options: ReticleVitePluginOptions): string {
  const args: Record<string, string | number | boolean> = {};
  const port = options.port ?? RETICLE_DEFAULT_PORT;
  if (port !== RETICLE_DEFAULT_PORT) args['url'] = bridgeWsUrl(port);
  if (options.session !== undefined) args['session'] = options.session;
  if (options.projectId !== undefined) args['projectId'] = options.projectId;
  if (options.token !== undefined) args['token'] = options.token;
  // Passed as connect ARGUMENTS, not as a `define`. A define substitutes a bare identifier in the
  // source it transforms; the SDK reads these as `globalThis[NAME]`, a dynamic lookup no define can
  // ever reach — so defining them looked right, shipped, and did nothing. Baking them into the
  // generated connect call is a literal in generated source: no bundler subtleties, works the same
  // in dev and in a desktop build.
  if (options.root !== undefined && options.root.length > 0) args['root'] = options.root;
  if (options.sdkVersion !== undefined && options.sdkVersion.length > 0) {
    args['sdkVersion'] = options.sdkVersion;
  }
  // A desktop renderer is a production build by construction; without this the SDK's prod backstop
  // refuses to connect and the app is silently uninstrumented.
  if (true === options.desktop) args['allowInProduction'] = true;
  // Env wins nothing — it only turns the flag ON, so a config that never set it can still be
  // switched on for one debugging session without editing vite.config and restarting the mental
  // model with it.
  if (true === options.captureNetworkBodies || '1' === process.env['VITE_RETICLE_CAPTURE_BODIES']) {
    args['captureNetworkBodies'] = true;
  }
  // Same shape, same reason -- except this one carries a value, so the env var is parsed rather than
  // tested for '1'. A non-numeric env var is ignored rather than fatal: it must not take down an
  // app's dev server, and the SDK clamps whatever does arrive.
  const envBodyChars = Number(process.env['VITE_RETICLE_BODY_MAX_CHARS']);
  const bodyChars =
    options.networkBodyMaxChars ??
    (Number.isFinite(envBodyChars) && envBodyChars > 0 ? envBodyChars : undefined);
  if (bodyChars !== undefined) {
    args['networkBodyMaxChars'] = bodyChars;
  }
  // The one option that defaults ON, so the env var and the config flag both DISABLE rather than
  // enable. Emitted only when switched off; the default stays implicit in the SDK.
  if (false === options.captureErrorBodies || '1' === process.env['VITE_RETICLE_NO_ERROR_BODIES']) {
    args['captureErrorBodies'] = false;
  }
  // Same shape, same reason. Off unless asked for, in a config or for one session.
  if (true === options.exposePresenter || '1' === process.env['VITE_RETICLE_EXPOSE_PRESENTER']) {
    args['exposePresenter'] = true;
  }
  // Same shape, same reason: without it an app that cannot be served on localhost has no way to
  // reach the SDK option at all. The pairing token still applies — see the option's docstring.
  if (
    true === options.allowNonLocalhost ||
    '1' === process.env['VITE_RETICLE_ALLOW_NON_LOCALHOST']
  ) {
    args['allowNonLocalhost'] = true;
  }
  return Object.keys(args).length > 0 ? JSON.stringify(args) : '';
}
