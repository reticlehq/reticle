/**
 * A stable, privacy-safe fingerprint for a finding — so the same defect can be recognised across
 * sessions without sending any app-specific data over the wire.
 *
 * The hash travels in `bug_found`; the inputs (route, selector) never do. Same pattern as
 * `projectId`: hash the identifying bits, send only the hash, let the analytics side group by it.
 */

import { fnv1a } from './contract-fingerprint.js';

export interface FindingIdentity {
  /** The classified kind from Reticle's findings vocabulary (`signal-contradicted`, `console-error`, …). */
  kind: string;
  /** How Reticle found it (`contradiction`, `crawl`, `assertion`, `replay`). */
  source: string;
  /** The route the app was on when this was found. Hashed, never sent raw. */
  route?: string;
}

/**
 * Produce a short hex fingerprint that identifies a finding stably across sessions.
 *
 * Same inputs = same output, regardless of when or where it runs. A changed route or a changed
 * kind = a different fingerprint = a different defect. The analytics side can then answer "was this
 * fixed?" by checking whether a fingerprint stops appearing.
 */
export function fingerprintFinding(identity: FindingIdentity): string {
  const canonical = [identity.kind, identity.source, identity.route ?? ''].join('\x00');
  return fnv1a(canonical);
}
