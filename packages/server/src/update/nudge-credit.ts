/**
 * Did the update nudge cause the update?
 *
 * `version_changed` says a version moved. It has never said why, so the only question worth asking
 * about the nudge — does telling agents about a release make releases get installed — was
 * unanswerable. That is not academic: 2.4.0 carried a fix for a connect defect affecting every Vite
 * app and reached zero users, and nothing in the data could distinguish "the nudge never fired" from
 * "the nudge fired and nobody acted on it". Those need opposite responses.
 *
 * The nudge is delivered by a DAEMON; `reticle update` runs in a different process. They cannot see
 * each other in memory, so a marker file is the join. It holds the version that was offered and
 * when — no identity, nothing about the machine, and it is overwritten rather than appended.
 *
 * Every function here swallows its own errors. This runs inside `reticle update`, which must finish
 * whatever the telemetry believes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIR = join(homedir(), '.reticle');
const FILE = 'update-nudge.json';

interface NudgeRecord {
  /** The version the agent was told about. */
  offered: string;
  /** When, so a nudge from months ago does not take credit for today's upgrade. */
  at: number;
}

/**
 * How long a nudge can plausibly have caused an update. A week is generous for "the agent mentioned
 * it and the human got round to it"; beyond that the two are unrelated events that happen to share a
 * version number.
 */
const CREDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Record that an agent was told about `version`. Called when the nudge is actually delivered. */
export function creditNudge(version: string, dir: string = DEFAULT_DIR, now = Date.now()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const record: NudgeRecord = { offered: version, at: now };
    writeFileSync(join(dir, FILE), JSON.stringify(record), 'utf8');
  } catch {
    /* a metric must never break the nudge */
  }
}

/** True when this exact version was offered to an agent recently enough to have caused the update. */
export function wasNudged(version: string, dir: string = DEFAULT_DIR, now = Date.now()): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    if (typeof parsed !== 'object' || null === parsed) return false;
    const record = parsed as Partial<NudgeRecord>;
    if (record.offered !== version || typeof record.at !== 'number') return false;
    return now - record.at <= CREDIT_WINDOW_MS;
  } catch {
    return false;
  }
}
