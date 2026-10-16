import { HelloEnv, HelloScope } from '@reticlehq/core';
import type { ProductionDrive } from './production-drive.js';

/**
 * Which HELLO may open a production session, and with what scope.
 *
 * The nonce decides, never the page. A page that says `production` without a production nonce is
 * refused, because the pairing token belongs to a developer's machine and must not open a drive on a
 * live site. A production nonce makes the session production even when the page says nothing: a page
 * cannot talk its way out of the policy. The page may narrow `act` to `observe`, and never widen.
 */

/** The close reason for a refused production HELLO. Under the 123-byte close-frame limit. */
export const PRODUCTION_HELLO_REFUSED =
  'production mode refused — it needs a live production session nonce and a scope';

export type HelloAdmission =
  { ok: true; production?: ProductionDrive } | { ok: false; reason: string };

export function admitHello(
  hello: { env?: HelloEnv | undefined; scope?: HelloScope | undefined },
  granted: ProductionDrive | undefined,
): HelloAdmission {
  const claimsProduction = hello.env === HelloEnv.PRODUCTION;
  if (granted === undefined) {
    return claimsProduction ? { ok: false, reason: PRODUCTION_HELLO_REFUSED } : { ok: true };
  }
  if (claimsProduction && hello.scope === undefined) {
    return { ok: false, reason: PRODUCTION_HELLO_REFUSED };
  }
  if (hello.scope === HelloScope.OBSERVE) granted.narrowToObserve();
  return { ok: true, production: granted };
}
