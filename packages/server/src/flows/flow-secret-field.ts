import { AnchorKind, type FlowAnchor } from '@reticlehq/core';

/**
 * What the anchor CALLS the field it points at.
 *
 * Every anchor kind names its target differently and all of them can name a password: a testid
 * (auth-password), an accessible name (role=textbox, name="Password"), a signal. Checking only the
 * testid variant would redact the app that uses test ids and quietly leak the one that does not —
 * and an app without test ids is exactly the app whose flows were recorded by role.
 *
 * Save and replay MUST share this. Redaction keys off the field name; substitution looks up
 * `RETICLE_SECRET_<FIELD>` from the same string. Two copies would redact `Password` and then fail
 * to find the env var because the runner passed a role or a label instead.
 */
export function anchorFieldName(anchor: FlowAnchor): string | undefined {
  if (AnchorKind.TESTID === anchor.kind) return anchor.value;
  if (AnchorKind.ROLE === anchor.kind) return anchor.name;
  if (AnchorKind.SIGNAL === anchor.kind) return anchor.name;
  return undefined;
}
