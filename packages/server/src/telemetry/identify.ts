/**
 * `reticle identify` — the ONLY way Reticle ever learns who you are, and it is a thing you type.
 *
 * The product question behind this is real: which of these anonymous ids are companies who would pay
 * for support, an enterprise licence, or a design-partner slot? The tempting answer is to infer it —
 * match a git remote against a company domain, sniff an email out of `git config`, resolve an npm org.
 * Reticle does none of that, and the refusal is deliberate rather than squeamish:
 *
 *   - it would contradict a promise made in four places (README, usage, enterprise FAQ, telemetry
 *     policy) that project names, git remotes and account identifiers are never sent;
 *   - covert identification of a data subject is not "anonymous usage metrics", so it would also
 *     break the legal basis the policy states — legitimate interest, minimized to the listed fields;
 *   - and it is worse at the actual job. A scraped lead is a cold email from a tool the recipient
 *     trusted, which is the fastest way to turn an advocate into someone who runs
 *     `reticle telemetry disable` and tells their team to do the same. A self-identified one already
 *     wants to talk to you.
 *
 * So this is opt-in, explicit, reversible, and it tells the user exactly what it links before it
 * sends anything.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TelemetryEventKind, UsageContextKind, type Identity } from '@reticlehq/core/telemetry';
import { getTelemetry } from './telemetry.js';

const RETICLE_DIR = join(homedir(), '.reticle');
/** Persisted so the identity survives shells and is attached to later sessions — and so it can be shown back. */
const IDENTITY_FILE = join(RETICLE_DIR, 'identity.json');

/** Re-exported so the CLI has one import for the whole feature; the shape itself lives in core. */
export { UsageContextKind };
export type { Identity };

export function readIdentity(file: string = IDENTITY_FILE): Identity | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Identity;
  } catch {
    return undefined;
  }
}

export function saveIdentity(identity: Identity, file: string = IDENTITY_FILE): void {
  mkdirSync(RETICLE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(identity, null, 2), 'utf8');
}

export function clearIdentity(file: string = IDENTITY_FILE): void {
  rmSync(file, { force: true });
}

/**
 * What identifying yourself actually does, in plain words, shown BEFORE anything is sent.
 *
 * The second sentence is the one that matters and the one a consent notice usually omits: the
 * identity is keyed to the same anonymous id the previous events carried, so opting in links the
 * usage history that was already collected. That is exactly what makes it useful to us, which is
 * exactly why the user has to be told before they choose, not after.
 */
export const IDENTIFY_NOTICE = [
  'This sends the details you type here to the Reticle maintainers, so we can contact you and',
  "understand how teams use Reticle. It is linked to this machine's anonymous id, which means it",
  'also connects the anonymous usage already recorded from this machine to what you enter now.',
  'Nothing about your app, your code, or your repository is included, and nothing else changes.',
  'Undo it any time with `reticle identify --forget` (that stops future sends and deletes the local file;',
  'email support@reticlehq.com to have what was already sent removed).',
].join('\n');

/**
 * Report an identity. Emitted as its own event so it is trivially separable from the anonymous
 * stream — a distinct name is what lets the analytics side hold it under a different retention rule,
 * or drop it entirely, without touching the adoption metrics.
 */
export async function submitIdentity(identity: Identity): Promise<boolean> {
  const telemetry = getTelemetry();
  if (!telemetry.enabled) return false;
  await telemetry.emit(TelemetryEventKind.IDENTIFIED, { identity });
  return true;
}
