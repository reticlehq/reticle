import { AnchorKind, type FlowAnchor, type FlowFile } from '@reticlehq/core';

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

/**
 * What a redacted fill value is replaced WITH.
 *
 * Replaced, never dropped. Replay still needs a step there, and a flow that silently loses its
 * password step drifts at sign-in forever with no explanation of why. The placeholder also tells a
 * reader what to do: the value belongs in the environment, not in a file they are about to commit.
 */
export const REDACTED_FILL = '<redacted: supply at replay>';

/**
 * The environment variable that supplies one redacted field.
 *
 * Named after the field so it is guessable from the flow alone: `auth-password` is read from
 * `RETICLE_SECRET_AUTH_PASSWORD`. A scheme requiring a lookup table would mean the flow says a
 * value is missing and cannot say what to set.
 *
 * Lives HERE, beside `anchorFieldName`, for the reason that function's own header gives: redaction
 * keys off the field name and substitution looks the variable up from the same string, so the two
 * rules must not be able to drift. It used to sit in `replay.ts`, one import away from the sentence
 * saying it had to stay together.
 */
export const secretEnvKey = (field: string): string =>
  `RETICLE_SECRET_${field.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;

/** One field a flow needs supplied, and the variable that supplies it. */
export interface UnsuppliedSecret {
  field: string;
  envKey: string;
}

/**
 * Every credential this flow will replay as the literal placeholder.
 *
 * Checked BEFORE a step runs, because the alternative is what shipped: the placeholder is typed
 * into the password box, sign-in fails, and the flow reports that an element further down the
 * journey has gone missing -- a `drift` verdict naming a component nobody touched, with an
 * invitation to update a flow that was correct.
 *
 * The emptiness rule matches `replayActionArgs` exactly: it substitutes only for a value of
 * non-zero length, so an empty variable leaves the placeholder and must count as unsupplied here.
 * Two different answers to "is this supplied" is how the gate would pass and the replay still fail.
 */
export function unsuppliedSecrets(
  flow: FlowFile,
  env: Record<string, string | undefined>,
): UnsuppliedSecret[] {
  const out: UnsuppliedSecret[] = [];
  const seen = new Set<string>();
  for (const step of flow.steps ?? []) {
    if (REDACTED_FILL !== step.args?.['value']) continue;
    const field = anchorFieldName(step.anchor);
    if (field === undefined) continue;
    const envKey = secretEnvKey(field);
    const supplied = env[envKey];
    if (supplied !== undefined && supplied.length > 0) continue;
    if (seen.has(envKey)) continue;
    seen.add(envKey);
    out.push({ field, envKey });
  }
  return out;
}
