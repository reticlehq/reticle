/**
 * Pure coercion + grading helpers behind the act tools.
 *
 * Split out when act-tools.ts crossed the 600-line cap. The seam is that nothing here touches a
 * session, a command, or a tool definition — these are total functions over their arguments, which
 * is why they can be tested without a browser and why they were the right thing to move.
 */
import { ActionType, ConsequenceKind } from '@reticlehq/core';
import type { ElementBox } from '../input/real-input.js';
import { HonestyGrade } from '../honesty/honesty.js';
import type { ExpectedLink } from '../capsule/divergence.js';
import { asNumber, asRecord, asString } from './tools-helpers.js';

/** The strongest consequence grade a set of expected links proves (signal > net > state > presence). */
export function gradeOf(links: readonly ExpectedLink[]): HonestyGrade {
  if (links.some((l) => ConsequenceKind.SIGNAL === l.kind)) return HonestyGrade.SIGNAL;
  if (links.some((l) => ConsequenceKind.NET === l.kind)) return HonestyGrade.NET;
  if (links.some((l) => ConsequenceKind.STATE === l.kind)) return HonestyGrade.STATE;
  return HonestyGrade.PRESENCE;
}

/** Narrow an INSPECT result's `box` into a positive-area ElementBox (else undefined). */
export function asBox(value: unknown): ElementBox | undefined {
  const b = asRecord(asRecord(value)['box']);
  const x = asNumber(b['x']);
  const y = asNumber(b['y']);
  const w = asNumber(b['width']);
  const h = asNumber(b['height']);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  if (w <= 0 || h <= 0) return undefined; // zero-area (display:none) ⇒ native click would miss
  return { x, y, width: w, height: h };
}

/** Outcome of a real-input attempt — real success (result set) or synthetic with a reason. */
export function asActionType(value: unknown): ActionType | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  return (Object.values(ActionType) as string[]).includes(raw) ? (raw as ActionType) : undefined;
}
