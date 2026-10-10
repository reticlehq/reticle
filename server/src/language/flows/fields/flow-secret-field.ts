import { AnchorKind, type FlowAnchor, type FlowFile, type FlowStep } from '@reticlehq/core';

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

const SECRET_FILL_PREFIX = '<redacted: supply ';
const SECRET_FILL_SUFFIX = ' at replay>';
const SECRET_OCCURRENCE = /^(?:[2-9]|[1-9][0-9]+)$/;

/** Legacy fills use the field's key; repeated fills name their own key in the placeholder. */
export function secretKeyForFill(value: unknown, field: string): string | undefined {
  const base = secretEnvKey(field);
  if (REDACTED_FILL === value) return base;
  if (
    typeof value !== 'string' ||
    !value.startsWith(SECRET_FILL_PREFIX) ||
    !value.endsWith(SECRET_FILL_SUFFIX)
  ) {
    return undefined;
  }
  const key = value.slice(SECRET_FILL_PREFIX.length, -SECRET_FILL_SUFFIX.length);
  // A saved placeholder may only read this field's key, never an unrelated environment variable.
  return key.startsWith(`${base}_`) && SECRET_OCCURRENCE.test(key.slice(base.length + 1))
    ? key
    : undefined;
}

function* secretSteps(steps: readonly FlowStep[]): Generator<FlowStep> {
  for (const step of steps) {
    yield step;
    if (step.steps !== undefined) yield* secretSteps(step.steps);
  }
}

/** Give each redacted fill its own supply while keeping existing placeholders byte-stable. */
export function withDistinctSecretKeys(flow: FlowFile): FlowFile {
  const reserved = new Set<string>();
  const used = new Set<string>();
  for (const step of secretSteps(flow.steps)) {
    const field = anchorFieldName(step.anchor);
    if (field === undefined) continue;
    const key = secretKeyForFill(step.args?.['value'], field);
    if (key === undefined) continue;
    reserved.add(key);
    if (REDACTED_FILL !== step.args?.['value']) used.add(key);
  }
  const assign = (step: FlowStep): FlowStep => {
    let out = step;
    const field = anchorFieldName(step.anchor);
    if (REDACTED_FILL === step.args?.['value'] && field !== undefined) {
      const base = secretEnvKey(field);
      let key = base;
      let occurrence = 2;
      while (used.has(key) || (key !== base && reserved.has(key))) {
        key = `${base}_${occurrence}`;
        occurrence += 1;
      }
      used.add(key);
      if (key !== base) {
        out = {
          ...step,
          args: { ...step.args, value: `${SECRET_FILL_PREFIX}${key}${SECRET_FILL_SUFFIX}` },
        };
      }
    }
    return step.steps === undefined ? out : { ...out, steps: step.steps.map(assign) };
  };
  return { ...flow, steps: flow.steps.map(assign) };
}

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
  for (const step of secretSteps(flow.steps ?? [])) {
    const field = anchorFieldName(step.anchor);
    if (field === undefined) continue;
    const envKey = secretKeyForFill(step.args?.['value'], field);
    if (envKey === undefined) continue;
    const supplied = env[envKey];
    if (supplied !== undefined && supplied.length > 0) continue;
    if (seen.has(envKey)) continue;
    seen.add(envKey);
    out.push({ field, envKey });
  }
  return out;
}
