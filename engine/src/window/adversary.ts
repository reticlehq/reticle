/**
 * An SDK that tells us the bare minimum, built on purpose.
 *
 * Every optional field on the wire exists because some version of the page could not supply it: an
 * older SDK, a framework that hides the information, a setting somebody switched off. The code that
 * reads those fields is written to cope, and this file exists because "written to cope" is a claim
 * nobody had checked all at once.
 *
 * The rule it tests is the one this codebase states over and over, in `captureBodies`, in
 * `sourceMapping`, in the protocol version: **absent means unknown, never false.** A reader that
 * treats a missing field as a negative answer turns silence into evidence, and silence is the one
 * thing every old and minimal client has in common.
 *
 * So: for each kind of event, the smallest payload the contract still accepts. Nothing optional,
 * nothing helpful, everything the schema demands and not one field more.
 *
 * This is not a fuzzer. It does not send malformed input -- the schemas already reject that, and a
 * rejection is a good outcome. It sends input that is entirely VALID and entirely unhelpful, which
 * is what a real minimal client looks like and what no fixture in this repository resembles.
 */

import * as z from 'zod';
import { EVENT_PAYLOAD_SCHEMAS, EventType, type ReticleEvent } from '@reticlehq/core';

/** A value that satisfies a schema while carrying as little as the contract allows. */
function barestValue(schema: z.ZodType): unknown {
  // An optional field is the whole point: leave it out.
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return undefined;
  }
  if (schema instanceof z.ZodString) {
    // A minimum length is part of the contract, not decoration: `note` and `anchor` on a human
    // mark both demand one. The barest string that still parses is one character, not none.
    return 'x'.repeat(schema.minLength ?? 0);
  }
  if (schema instanceof z.ZodNumber) {
    // `.int()` reports the smallest safe integer as its minimum; that is no lower bound to honour.
    const min = schema.minValue;
    const value = null !== min && Number.MIN_SAFE_INTEGER < min ? min : 0;
    return schema.safeParse(value).success ? value : value + 1;
  }
  if (schema instanceof z.ZodBoolean) {
    return false;
  }
  if (schema instanceof z.ZodArray) {
    return [];
  }
  if (schema instanceof z.ZodRecord) {
    return {};
  }
  // A tuple has a fixed length, so the barest one still has every item.
  if (schema instanceof z.ZodTuple) {
    return schema.def.items.map((item) => barestValue(item as z.ZodType));
  }
  if (schema instanceof z.ZodLiteral) {
    return schema.value;
  }
  if (schema instanceof z.ZodEnum) {
    return schema.options[0];
  }
  if (schema instanceof z.ZodUnion) {
    return barestValue(schema.options[0] as z.ZodType);
  }
  if (schema instanceof z.ZodObject) {
    return barestObject(schema);
  }
  // Unknown, any, and anything else the contract does not constrain.
  return undefined;
}

/** The smallest object that still parses: required keys only, each at its barest value. */
function barestObject(schema: z.ZodObject): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const value = barestValue(field as z.ZodType);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * One event of each kind, carrying the least the contract accepts.
 *
 * Timestamps ascend so a window has an order; nothing else is offered. The event id is fixed rather
 * than random, because a test that fails only sometimes is one people re-run rather than read.
 */
export function barestEvents(): ReticleEvent[] {
  return Object.values(EventType).map((type, index) => {
    const payload = EVENT_PAYLOAD_SCHEMAS[type];
    return {
      type,
      t: index + 1,
      data: barestValue(payload) ?? {},
    } as unknown as ReticleEvent;
  });
}
