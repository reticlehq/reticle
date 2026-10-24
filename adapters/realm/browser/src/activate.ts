import {
  HelloEnv,
  PRODUCTION_ACTIVATE_PARAM,
  verifyActivationTicket,
} from '@reticlehq/core/activation';
import type { ReticleConnectOptions } from './connect-options.js';

/**
 * `@reticlehq/browser/activate` — the loader a staging or production build ships.
 *
 * A visitor's page load reads one query parameter and stops. Only a page opened with a valid
 * `reticle_activate` ticket loads the SDK and connects, with the ticket's single-use nonce, to the
 * ticket's bridge. The ticket is signed by the Reticle service and checked here with its public key,
 * so a forged, expired or other-origin ticket loads nothing.
 *
 * Imports only `@reticlehq/core/activation`, never the SDK barrel: the SDK arrives through a dynamic
 * import, so a bundler puts it in a chunk that no visitor downloads.
 */

export interface ActivateOptions {
  /** The service's Ed25519 public key: raw 32 bytes, base64url. The dashboard shows it. */
  publicKey: string;
}

/** What `activate` touches, so a test can see that it touches nothing. */
export interface ActivateHost {
  location: Pick<Location, 'href' | 'origin'>;
  history: Pick<History, 'replaceState' | 'state'>;
  now: () => number;
  connect: () => Promise<{ connect: (options: ReticleConnectOptions) => void }>;
  warn: (message: string) => void;
}

const REFUSED_PREFIX = '[Reticle] activation refused: ';

function pageHost(): ActivateHost | undefined {
  if ('undefined' === typeof location || 'undefined' === typeof history) return undefined;
  return {
    location,
    history,
    now: () => Date.now(),
    connect: () => import('./reticle-singleton.js').then((sdk) => sdk.reticle),
    // The one line a refused activation leaves. Only a page opened with the parameter can reach it.
    warn: (message) => console.warn(message),
  };
}

/**
 * Connect the SDK when, and only when, the page carries a valid activation ticket. Resolves true
 * when it connected. Without the parameter it returns at once and does nothing else.
 */
export async function activate(
  options: ActivateOptions,
  host: ActivateHost | undefined = pageHost(),
): Promise<boolean> {
  if (host === undefined) return false;
  const url = new URL(host.location.href);
  const ticket = url.searchParams.get(PRODUCTION_ACTIVATE_PARAM);
  if (null === ticket) return false;
  // The ticket is a credential: take it out of the address bar before anything can read or share it.
  url.searchParams.delete(PRODUCTION_ACTIVATE_PARAM);
  host.history.replaceState(host.history.state, '', url.toString());
  const verdict = await verifyActivationTicket(ticket, {
    publicKey: options.publicKey,
    origin: host.location.origin,
    now: host.now(),
  });
  if (!verdict.ok) {
    host.warn(`${REFUSED_PREFIX}${verdict.reason}`);
    return false;
  }
  const { payload } = verdict;
  const sdk = await host.connect();
  sdk.connect({
    url: payload.bridge,
    token: payload.nonce,
    env: HelloEnv.PRODUCTION,
    scope: payload.scope,
    allowInProduction: true,
    allowNonLocalhost: true,
  });
  return true;
}
