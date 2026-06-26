/**
 * Example enterprise feature (Iris Enterprise License — see ./LICENSE). Demonstrates the pattern every
 * ee feature follows: call assertEnterprise(...) first, then do the privileged work. The body here is a
 * stub — the real audit sink is the hosted control plane. It exists now to prove the gate.
 */

import { assertEnterprise, type GateContext } from '../license/license.js';

interface AuditEvent {
  actor: string;
  action: string;
  at: number;
}

/** Record an audit event — gated. Throws EnterpriseLicenseError in production without a valid license. */
export function recordAuditEvent(event: AuditEvent, ctx: GateContext): AuditEvent {
  assertEnterprise('audit-log', ctx);
  return event; // stub: a real implementation persists to the enterprise audit store
}
