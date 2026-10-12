/**
 * The opt-in screen/request check, wired: after an act_and_wait, compare what the window's write
 * requests carried with the values the page's form controls show (engine: screen-request.ts).
 *
 * OPT-IN (`RETICLE_SCREEN_REQUEST_CHECK=1`) and ADVISORY. It ships behind the flag until its
 * false-alarm rate is measured at zero on the e2e battery, the benchmark and the persona fixtures;
 * until then it must cost nothing for anyone who did not ask. It runs AFTER the verdict is decided
 * and is appended to `contradictions` as an advisory kind, so it can never move a verdict.
 */
import {
  ContradictionKind,
  EventType,
  REDACTED_VALUE,
  ReticleCommand,
  type Contradiction,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';

export const SCREEN_REQUEST_CHECK_ENV = 'RETICLE_SCREEN_REQUEST_CHECK';
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The form controls whose value a request can carry. */
const CONTROL_ROLES: readonly string[] = ['combobox', 'listbox', 'textbox', 'spinbutton'];

/*
 * The rule itself — pure, and deliberately narrow so it cannot cry wolf: a control is matched to a
 * body field only by its `name` or `id`, exactly (case-insensitive); only top-level primitive fields
 * of a JSON-object body are compared; a control with no value, or a field the request did not carry,
 * is skipped, never guessed at. Kept here rather than in the engine, whose reach into core is held
 * flat on purpose (core-coupling-only-shrinks).
 */
export interface SentBody {
  method: string;
  url: string;
  /** The request body as sent (JSON text). */
  body: string;
}

export interface ShownControl {
  /** `name` or `id` attribute — the only link from a control to a field. */
  field: string;
  /** The control's current value (a select's selected option value, an input's text). */
  value: string;
  /** What the user sees, when it differs from the value (a select's option label). */
  label?: string | undefined;
  ref?: string | undefined;
}

function primitiveFields(body: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(body);
    if ('object' !== typeof parsed || null === parsed || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if ('string' === typeof value || 'number' === typeof value || 'boolean' === typeof value) {
        out.set(key.toLowerCase(), String(value));
      }
    }
  } catch {
    // Not JSON: nothing comparable, so nothing reported.
  }
  return out;
}

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://local.invalid').pathname;
  } catch {
    return url;
  }
}

export function screenRequestMismatches(
  sent: readonly SentBody[],
  controls: readonly ShownControl[],
): Contradiction[] {
  const out: Contradiction[] = [];
  for (const request of sent) {
    const fields = primitiveFields(request.body);
    if (0 === fields.size) continue;
    for (const control of controls) {
      const key = control.field.toLowerCase();
      const carried = fields.get(key);
      if (carried === undefined || carried === control.value) continue;
      const shown =
        control.label !== undefined && control.label !== control.value
          ? `"${control.label}" (value "${control.value}")`
          : `"${control.value}"`;
      out.push({
        kind: ContradictionKind.SCREEN_REQUEST_MISMATCH,
        claim: `the screen's "${control.field}" control shows ${shown}`,
        counter: `${request.method.toUpperCase()} ${pathOf(request.url)} sent ${control.field}=${JSON.stringify(carried)}`,
        detail: `${control.ref === undefined ? '' : `${control.ref} `}${control.field}: shown ${shown}, sent ${JSON.stringify(carried)}`,
      });
    }
  }
  return out;
}

function sentBodies(events: readonly ReticleEvent[]): SentBody[] {
  return events.flatMap((event) => {
    if (EventType.NET_REQUEST !== event.type) return [];
    const raw = event.data['method'];
    const method = ('string' === typeof raw ? raw : 'GET').toUpperCase();
    const body = event.data['requestBody'];
    const url = event.data['url'];
    if (READ_METHODS.has(method) || 'string' !== typeof body || 'string' !== typeof url) return [];
    return [{ method, url, body }];
  });
}

async function shownControls(session: Session): Promise<ShownControl[]> {
  const out: ShownControl[] = [];
  for (const role of CONTROL_ROLES) {
    const res = await session.command(ReticleCommand.MATCH, {
      query: { role, attrs: ['name', 'id'] },
    });
    if (!res.ok) continue;
    for (const el of (res.result as MatchResult | undefined)?.elements ?? []) {
      const field = el.attrs?.['name'] ?? el.attrs?.['id'];
      // No value read, or a redacted one: nothing to compare, so nothing is guessed.
      if (field === undefined || el.value === undefined || REDACTED_VALUE === el.value) continue;
      out.push({ field, value: el.value, ref: el.ref });
    }
  }
  return out;
}

/** Advisory findings for this window, or none when the check is off or nothing was written. */
export async function screenRequestFindings(
  session: Session,
  windowEvents: readonly ReticleEvent[],
): Promise<Contradiction[]> {
  if ('1' !== process.env[SCREEN_REQUEST_CHECK_ENV]) return [];
  const sent = sentBodies(windowEvents);
  if (0 === sent.length) return [];
  try {
    return screenRequestMismatches(sent, await shownControls(session));
  } catch {
    return [];
  }
}

/** The `contradictions` field: the verdict's own, then any advisory ones; omitted when both are empty. */
export function withAdvisories(
  decided: readonly Contradiction[],
  advisory: readonly Contradiction[],
): { contradictions?: Contradiction[] } {
  const all = [...decided, ...advisory];
  return 0 === all.length ? {} : { contradictions: all };
}
