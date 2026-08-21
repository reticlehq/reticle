/**
 * Enterprise activation, as the three facts telemetry reports on every event.
 *
 * WHY IT IS ON EVERY EVENT, not just an activation one: the questions a licensed customer generates
 * are "how much is this org using it", "what is breaking for them", "did their key lapse" — and every
 * one of those is answered by an event that has nothing to do with licensing. A status that rode only
 * its own event would tell us a key verified once and nothing about the sessions it covered. Same
 * reasoning that moved `installSource` onto every event.
 *
 * WHY STATUS IS SEPARATE FROM IDENTITY: `licenseId` is only present while a key verifies, so on
 * identity alone a lapsed customer and a departed one are the same silence. `licenseStatus` keeps
 * reporting through `expired` and `invalid`, which is the difference between seeing a renewal coming
 * and hearing about it from the customer.
 *
 * WHAT IS DELIBERATELY ABSENT: the organisation NAME. It is free text somebody typed at signing time,
 * and rule 3 of the telemetry contract is names-never-values. `licenseId` is an opaque uuid that
 * resolves to a company only against the issuance ledger held locally, so the analytics backend never
 * holds a customer list.
 */
import { LicenseActivation } from '@reticlehq/core';
import { describeLicense } from '../license/license.js';

/** The activation facts that ride the wire. All absent on a build with no issuer key baked. */
export interface LicenseFacts {
  licenseId?: string;
  licensePlan?: string;
  licenseStatus?: LicenseActivation;
}

/**
 * Resolve activation for one event. The clock is passed in (rule 7) and is the EVENT's clock, not a
 * value captured at startup: sessions here run to eleven hours, so a key that expires mid-session must
 * start reporting `expired` from the event it expired on rather than the whole run inheriting the
 * status it had at boot.
 *
 * `eval` reports NOTHING. It means no issuer key is baked at all, which is every OSS install and every
 * source checkout, so emitting it would add three properties to the dominant population to say "not a
 * licensed build" — which absence already says, more cheaply. A mis-built production release resolves
 * to `invalid` rather than `eval` and IS reported, because that one we need to hear about.
 *
 * Never throws. A telemetry property may not change behaviour (rule 5), and this one sits in front of
 * key parsing, which is the part most likely to be handed something malformed.
 */
export function licenseFacts(now: number, env: NodeJS.ProcessEnv = process.env): LicenseFacts {
  try {
    const report = describeLicense(now, env);
    if (LicenseActivation.EVAL === report.status) return {};
    return {
      licenseStatus: report.status,
      ...(report.licenseId !== undefined ? { licenseId: report.licenseId } : {}),
      ...(report.plan !== undefined ? { licensePlan: report.plan } : {}),
    };
  } catch {
    return {};
  }
}
