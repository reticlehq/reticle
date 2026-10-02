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

import { z } from 'zod';
import { EVENT_PAYLOAD_SCHEMAS, EventType, type ReticleEvent } from '@reticlehq/core';

/** A value that satisfies a schema while carrying as little as the contract allows. */
function barestValue(schema: z.ZodTypeAny): unknown {
  const def: {
    typeName?: string;
    innerType?: z.ZodTypeAny;
    shape?: () => Record<string, z.ZodTypeAny>;
    options?: z.ZodTypeAny[];
    value?: unknown;
    type?: z.ZodTypeAny;
  } = schema._def as never;

  switch (def.typeName) {
    // An optional field is the whole point: leave it out.
    case 'ZodOptional':
    case 'ZodNullable':
      return undefined;
    case 'ZodDefault':
      return undefined;
    case 'ZodString': {
      // A minimum length is part of the contract, not decoration: `note` and `anchor` on a human
      // mark both demand one. The barest string that still parses is one character, not none.
      const checks = (def as { checks?: { kind: string; value: number }[] }).checks ?? [];
      const min = checks.find((c) => 'min' === c.kind)?.value ?? 0;
      return 'x'.repeat(min);
    }
    case 'ZodNumber': {
      const checks = (def as { checks?: { kind: string; value: number }[] }).checks ?? [];
      return checks.find((c) => 'min' === c.kind)?.value ?? 0;
    }
    case 'ZodBoolean':
      return false;
    case 'ZodArray':
      return [];
    case 'ZodLiteral':
      return def.value;
    case 'ZodEnum':
      return (schema as unknown as z.ZodEnum<[string]>).options[0];
    case 'ZodNativeEnum':
      return Object.values((schema as unknown as z.ZodNativeEnum<never>)._def.values)[0];
    case 'ZodUnion':
      return barestValue((def.options ?? [])[0] as z.ZodTypeAny);
    case 'ZodRecord':
      return {};
    case 'ZodObject':
      return barestObject(schema as unknown as z.ZodObject<z.ZodRawShape>);
    default:
      // Unknown, any, and anything else the contract does not constrain.
      return undefined;
  }
}

/** The smallest object that still parses: required keys only, each at its barest value. */
function barestObject(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const value = barestValue(field);
    if (value !== undefined) out[key] = value;
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
