/**
 * Every sentence the Harness refuses with, and the platform's refusal codes they answer.
 *
 * The recogniser that tells an agent "this is a deliberate refusal, here is the way out" rather than
 * "this may be a defect in Reticle" used to match the PLATFORM's wording by regular expression. The
 * platform reworded its lock ("Harness is locked. Setup score: …") and every locked Harness came back
 * inviting a bug report. A refusal now carries the platform's CODE, the code picks a lead sentence
 * owned here, and the recogniser matches these constants — never another repository's prose.
 */

/** The codes the platform's refusals carry (`{ error: { code, message } }`, or a flat `error`). */
export const PlatformRefusalCode = {
  HARNESS_OFF: 'harness_off',
  HARNESS_LOCKED: 'harness_locked',
  NEEDS_CARD: 'needs_card',
} as const;

/** The lead sentence each code's refusal opens with: what the agent reads, and what is recognised. */
export const RefusalLead = {
  [PlatformRefusalCode.HARNESS_LOCKED]: 'Reticle Harness is locked for this project.',
  [PlatformRefusalCode.HARNESS_OFF]: 'The Reticle Harness is off for this project.',
  [PlatformRefusalCode.NEEDS_CARD]: 'This workspace has used all of its Reticle credits.',
} as const;

/** A platform refusal, read from its response body. Two shapes: nested `{ error: { code, message } }` and flat `{ error, message }`. */
export function readRefusal(text: string): { code?: string; message?: string } {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const nested =
      'object' === typeof body.error && null !== body.error
        ? (body.error as { code?: unknown; message?: unknown })
        : {};
    const code = 'string' === typeof body.error ? body.error : nested.code;
    const message = 'string' === typeof nested.message ? nested.message : body.message;
    return {
      ...('string' === typeof code ? { code } : {}),
      ...('string' === typeof message ? { message } : {}),
    };
  } catch {
    return {};
  }
}

const leadOf = (code: string | undefined): string | undefined =>
  Object.entries(RefusalLead).find(([known]) => known === code)?.[1];

/** The sentence a refusal is told in: the code's own lead, then the platform's words. */
export function refusalSentence(
  refusal: { code?: string; message?: string },
  status: number,
): string {
  const message = refusal.message ?? `the platform answered ${String(status)}`;
  const lead = leadOf(refusal.code);
  return lead === undefined || message.startsWith(lead) ? message : `${lead} ${message}`;
}

/**
 * What a person said about autonomous driving on the platform, honoured here.
 *
 * The switch existed, persisted and round-tripped, and the daemon read it and threw it away — so
 * turning the harness OFF changed a value in a database and nothing else. A control that does not
 * control anything is worse than no control: somebody turns it off, watches Reticle drive their app
 * anyway, and now correctly distrusts every other switch in the product.
 *
 * Absent means OFF. The Harness is opt-in: a new project starts with it off, and an answer that does
 * not say it is on is not a yes to spend credits on.
 */
export const MSG_HARNESS_DISABLED =
  "The Reticle Harness is off for this project. The user can switch it on in the HUD's Settings " +
  'or the Reticle dashboard (Settings → Projects → Reticle Harness on <project>); until then, drive the app yourself ' +
  'through the MCP tools.';

/**
 * The other reason a drive can be refused, and it is NOT the same reason.
 *
 * A drive through the platform spends Reticle's model budget, bounded by the workspace's Harness
 * credits. The platform answers this only when something other than the switch stops it.
 */
export const MSG_HARNESS_UNCLAIMED =
  'The Reticle platform says this workspace cannot drive the Harness right now, usually because its ' +
  'credits are spent: see Settings → Plan in the Reticle dashboard.';

/** The platform could not be asked, and the drive would spend Reticle's budget without its yes. */
export const MSG_HARNESS_UNCONFIRMED =
  'Could not confirm Harness access with the Reticle platform, so the drive did not start. Try ' +
  'again in a moment.';
