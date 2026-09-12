import { FeedbackKind, FeedbackSource } from '@reticlehq/core/telemetry';
import {
  AGENT_FLAG,
  BUG_FLAG,
  FEEDBACK_KINDS,
  KIND_FLAG,
  RATING_FLAG,
} from '../command/cli/cli-parse.js';
import { describeFeedbackPayload, submitFeedback } from './feedback.js';
import { describeTelemetry, setTelemetryEnabled } from './telemetry.js';
import { TelemetryAction } from '../command/cli/cli-parse.js';
import {
  clearIdentity,
  IDENTIFY_NOTICE,
  readIdentity,
  saveIdentity,
  submitIdentity,
  UsageContextKind,
} from './identify.js';

/**
 * `reticle feedback [--rating 1-5] [--bug] "what happened"` — the feedback channel as a command.
 *
 * Kept to a single command with no prompts, no editor, and no account: the cost of telling us
 * something has to be lower than the cost of shrugging and moving on, or we only ever hear from people
 * angry enough to open an issue. A bare rating is a valid report; the words are optional garnish.
 *
 * `--agent --kind <…>` is the same channel for an AGENT that cannot reach `reticle_feedback` — during
 * `init`, while instrumentation is half-wired, or when the daemon will not start. Those are the
 * reports we are least likely to hear and most need: every other path we have requires the tool
 * surface to already work, so a Reticle that fails before it is running fails silently by design.
 *
 * What is sent is PRINTED before it goes, every time. A channel that carries free text and does not
 * show you the payload is asking for trust it has not earned.
 */
export async function handleFeedback(
  text: string,
  rating: number | undefined,
  bug: boolean,
  feedbackKind?: string,
  agent = false,
): Promise<void> {
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  if ('' === text && rating === undefined) {
    line(`usage: reticle feedback [${RATING_FLAG} 1-5] [${BUG_FLAG}] "what worked, what didn't"`);
    line(
      `       agents: reticle feedback ${AGENT_FLAG} ${KIND_FLAG} <${FEEDBACK_KINDS.join('|')}> "what happened"`,
    );
    line('       your words go to the maintainers; nothing from your app is ever included.');
    process.exitCode = 1;
    return;
  }
  const receipt = await submitFeedback({
    // An agent filing through the CLI must not land in the HUMAN bucket: that bucket carries the
    // ratings and the experience reports, and a few hundred agent reports mixed into it would make
    // the one number that says whether people like Reticle mean nothing.
    source: agent ? FeedbackSource.AGENT : FeedbackSource.HUMAN,
    // `--kind` wins when given; `--bug` stays the shorthand it always was.
    kind:
      (feedbackKind as FeedbackKind | undefined) ??
      (bug ? FeedbackKind.BUG : FeedbackKind.EXPERIENCE),
    // A rating with no words is a real report, but the schema wants text — say what the rating means.
    text: '' === text ? `rated ${String(rating)}/5 with no comment` : text,
    ...(rating !== undefined ? { rating } : {}),
  });
  line(`sending      ${JSON.stringify(describeFeedbackPayload(receipt.context))}`);
  if (receipt.redacted.length > 0) {
    line(`redacted     ${receipt.redacted.join(', ')} (removed before sending)`);
  }
  line(
    receipt.sent
      ? 'thanks       your feedback is in. it genuinely changes what gets built next.'
      : `not sent     ${receipt.reason ?? 'unknown reason'}`,
  );
  for (const extra of identifyInvite(agent)) line(extra);
}

/**
 * Offer a HUMAN a way to be replied to — printed after the receipt, never as a prompt.
 *
 * Feedback is anonymous by design and stays that way: the report has already been sent by the time
 * this prints, so nothing here gates or delays it. This is an offer, not a question.
 *
 * It routes through `reticle identify`, which already does consented identity properly — it prints
 * what it will send, states that identifying links this machine's prior anonymous history to that
 * identity, and has `--forget`. Capturing an address inline on `feedback_submitted` instead would
 * put PII on the anonymous event stream and break what `docs/telemetry.md` promises in public:
 * "no domain sniffing, no email inference" and "no personal data is collected".
 *
 * Only for humans (an agent has no email), and only when nobody has identified yet — so somebody
 * who declined is never asked twice.
 */
function identifyInvite(agent: boolean): readonly string[] {
  if (agent) return [];
  try {
    if (readIdentity() !== undefined) return [];
  } catch {
    return []; // unreadable identity file: say nothing rather than risk asking twice
  }
  return [
    '',
    'want a reply? `reticle identify --context <company|side_project|oss|learning> --email you@example.com`',
    '             optional, and it tells you exactly what it sends before sending it.',
  ];
}

/**
 * `reticle identify` — opt-in, and it shows the consent notice before it sends anything.
 *
 * Deliberately NOT interactive: a prompt that appears in the middle of someone's work is pressure,
 * and this is the one command where the user must be choosing freely. They type what they want to
 * share, or they never run it at all.
 */
export async function handleIdentify(parsed: {
  context?: string;
  company?: string;
  email?: string;
  forget: boolean;
}): Promise<void> {
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  if (parsed.forget) {
    clearIdentity();
    line('forgotten    the local identity file is deleted; nothing further is sent.');
    line('             to have what was already sent removed, email support@reticlehq.com');
    return;
  }
  const context = Object.values(UsageContextKind).find((k) => k === parsed.context);
  if (context === undefined) {
    const existing = readIdentity();
    if (existing !== undefined) line(`current      ${JSON.stringify(existing)}`);
    line(`usage: reticle identify --context <${Object.values(UsageContextKind).join('|')}>`);
    line('       [--company "Acme"] [--email you@acme.com] [--forget]');
    line('');
    line(IDENTIFY_NOTICE);
    process.exitCode = existing === undefined ? 1 : 0;
    return;
  }
  const identity = {
    context,
    ...(parsed.company !== undefined ? { company: parsed.company } : {}),
    ...(parsed.email !== undefined ? { email: parsed.email } : {}),
  };
  line(IDENTIFY_NOTICE);
  line('');
  line(`sending      ${JSON.stringify(identity)}`);
  saveIdentity(identity);
  const sent = await submitIdentity(identity);
  line(
    sent
      ? 'thanks       saved and sent. we may reach out; `reticle identify --forget` undoes this.'
      : 'not sent     telemetry is disabled on this machine, so it was saved locally only.',
  );
}

/**
 * `reticle telemetry [status|enable|disable]` — the user-facing control for anonymous usage metrics.
 * `disable` persists a machine-wide opt-out (survives shells, unlike RETICLE_TELEMETRY=0); `status`
 * says what's on, why, and where the full policy lives. Human-readable to stdout, like `doctor`.
 */
export function handleTelemetry(action: TelemetryAction): void {
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  if (action !== TelemetryAction.STATUS) {
    setTelemetryEnabled(action === TelemetryAction.ENABLE);
  }
  const state = describeTelemetry();
  line(`telemetry    ${state.enabled ? 'enabled' : 'disabled'}  (${state.reason})`);
  line(`policy       ${state.policyUrl}`);
  if (state.enabled)
    line('opt out      reticle telemetry disable  (or RETICLE_TELEMETRY=0 / DO_NOT_TRACK=1)');
}
