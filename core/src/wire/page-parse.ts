/**
 * The two messages a page reads on the way in, checked without zod.
 *
 * Every page that loads the SDK downloads what its first load imports. A zod schema there brings
 * most of zod with it: one classic schema is about 85 KB, and zod mini beside a classic schema in a
 * later chunk brings zod's whole core (#2369). So the page checks a command and an element query
 * with these functions, and zod stays in the chunks a page fetches later.
 *
 * `CommandMessageSchema` (messages.ts) and `ElementQuerySchema` (types.ts) stay the definitions.
 * `page-parse.test.ts` drives both with generated input and fails when the two answers differ.
 *
 * Only zod-free modules are imported here. `first-load-size.test.ts` fails when zod reaches the
 * first load.
 */

import { MessageKind, QueryBy, TRANSPORT_LIMITS } from './constants/constants.js';
import { OutwardAction } from '@/verdict/security.js';
import type { CommandMessage } from './messages.js';
import type { ElementQuery } from './types.js';

/** Who sent a command: the Harness, or (when absent) the agent connected to the daemon. */
export const CommandActor = {
  HARNESS: 'harness',
} as const;
export type CommandActor = (typeof CommandActor)[keyof typeof CommandActor];

/** How many outward actions one Harness command may allow. Same bound as `CommandMessageSchema`. */
export const MAX_OUTWARD_ALLOWED = 16;

/** What a check returns: the value as the schema would output it, or why it was refused. */
export type PageParse<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

type Fields = Record<string, unknown>;

/** The one key a copy must not assign: it would set the copy's prototype, not a field. */
const PROTO_KEY = '__proto__';

function isFields(value: unknown): value is Fields {
  return 'object' === typeof value && value !== null && !Array.isArray(value);
}

/**
 * A plain object, as zod's `isPlainObject` reads it: an object literal, or one with no prototype.
 * An array, a class instance or a value with a changed prototype is not one.
 */
function isPlainFields(value: unknown): value is Fields {
  if (!isFields(value)) {
    return false;
  }
  const ctor: unknown = Reflect.get(value, 'constructor');
  if (ctor === undefined || 'function' !== typeof ctor) {
    return true;
  }
  const prototype: unknown = Reflect.get(ctor, 'prototype');
  return isFields(prototype) && Object.prototype.hasOwnProperty.call(prototype, 'isPrototypeOf');
}

/**
 * The record `z.record(z.string(), z.unknown())` outputs: a fresh object with the input's own
 * enumerable keys. `__proto__` is skipped, as zod skips it, so a key cannot replace the prototype.
 */
function copyRecord(input: Fields): Fields {
  // `fromEntries` defines data properties and never calls a setter, so no key can reach a prototype.
  return Object.fromEntries(Object.entries(input).filter(([key]) => PROTO_KEY !== key));
}

function refuse<T>(error: string): PageParse<T> {
  return { ok: false, error };
}

function oneOf(table: Readonly<Record<string, string>>, value: unknown): boolean {
  return 'string' === typeof value && Object.values(table).includes(value);
}

/** A string of `min` to `max` characters, as `z.string().min(min).max(max)` counts them. */
function isText(value: unknown, min: number, max: number): value is string {
  return 'string' === typeof value && value.length >= min && value.length <= max;
}

/** True for an attribute NAME. `attrs` projects attributes; `name=value` is not a filter. */
export function isAttrName(name: string): boolean {
  return !name.includes('=');
}

/** A command from the agent, as `CommandMessageSchema` reads it. Unknown keys are dropped. */
export function parseCommandMessage(input: unknown): PageParse<CommandMessage> {
  if (!isFields(input)) {
    return refuse('a command is an object');
  }
  if (input['kind'] !== MessageKind.COMMAND) {
    return refuse(`\`kind\` is not "${MessageKind.COMMAND}"`);
  }
  if (!isText(input['id'], 1, TRANSPORT_LIMITS.MAX_COMMAND_ID_LENGTH)) {
    return refuse(
      `\`id\` is not a string of 1 to ${String(TRANSPORT_LIMITS.MAX_COMMAND_ID_LENGTH)} characters`,
    );
  }
  const sessionId = input['sessionId'];
  if (sessionId !== undefined && !isText(sessionId, 1, TRANSPORT_LIMITS.MAX_SESSION_ID_LENGTH)) {
    return refuse(
      `\`sessionId\` is not a string of 1 to ${String(TRANSPORT_LIMITS.MAX_SESSION_ID_LENGTH)} characters`,
    );
  }
  if (!isText(input['name'], 1, TRANSPORT_LIMITS.MAX_COMMAND_NAME_LENGTH)) {
    return refuse(
      `\`name\` is not a string of 1 to ${String(TRANSPORT_LIMITS.MAX_COMMAND_NAME_LENGTH)} characters`,
    );
  }
  const rawArgs = input['args'] === undefined ? {} : input['args'];
  if (!isPlainFields(rawArgs)) {
    return refuse('`args` is not an object');
  }
  const args = copyRecord(rawArgs);
  const by = input['by'];
  if (by !== undefined && !oneOf(CommandActor, by)) {
    return refuse('`by` is not a known actor');
  }
  const outward = input['outward'];
  let allowed: OutwardAction[] | undefined;
  if (outward !== undefined) {
    const list = isFields(outward) ? outward['allowed'] : undefined;
    if (
      !Array.isArray(list) ||
      list.length > MAX_OUTWARD_ALLOWED ||
      !list.every((a) => oneOf(OutwardAction, a))
    ) {
      return refuse(
        `\`outward.allowed\` is not a list of at most ${String(MAX_OUTWARD_ALLOWED)} outward actions`,
      );
    }
    allowed = list as OutwardAction[];
  }
  const value: Fields = { kind: MessageKind.COMMAND, id: input['id'], name: input['name'], args };
  if ('sessionId' in input) {
    value['sessionId'] = sessionId;
  }
  if ('by' in input) {
    value['by'] = by;
  }
  if ('outward' in input) {
    value['outward'] = allowed === undefined ? undefined : { allowed };
  }
  return { ok: true, value: value as CommandMessage };
}

/** The keys of an element query that hold an optional string. */
const QUERY_TEXT_KEYS = [
  'value',
  'role',
  'name',
  'text',
  'label',
  'placeholder',
  'testid',
  'alt',
  'component',
  'scope',
] as const;
/** The keys of an element query that hold an optional boolean. */
const QUERY_FLAG_KEYS = ['self', 'matchCase'] as const;
const QUERY_KEYS: ReadonlySet<string> = new Set<string>([
  'by',
  'attrs',
  'source',
  ...QUERY_TEXT_KEYS,
  ...QUERY_FLAG_KEYS,
]);
const SOURCE_KEYS: ReadonlySet<string> = new Set(['file', 'line', 'column']);

/** A finite number, as zod 4's `z.number()` accepts it. */
function isNumber(value: unknown): value is number {
  return 'number' === typeof value && Number.isFinite(value);
}

function sourceError(source: unknown): string | undefined {
  if (!isFields(source)) {
    return '`source` is not an object';
  }
  const unknown = Object.keys(source).find((key) => !SOURCE_KEYS.has(key));
  if (unknown !== undefined) {
    return `\`source\` has an unknown key: "${unknown}"`;
  }
  if ('string' !== typeof source['file'] || !isNumber(source['line'])) {
    return '`source` needs a string `file` and a number `line`';
  }
  if (source['column'] !== undefined && !isNumber(source['column'])) {
    return '`source.column` is not a number';
  }
  return undefined;
}

/** An element query, as `ElementQuerySchema` reads it. An unknown key is refused. */
export function parseElementQuery(input: unknown): PageParse<ElementQuery> {
  if (!isFields(input)) {
    return refuse('a query is an object');
  }
  const unknown = Object.keys(input).find((key) => !QUERY_KEYS.has(key));
  if (unknown !== undefined) {
    return refuse(`the query has an unknown key: "${unknown}"`);
  }
  if (input['by'] !== undefined && !oneOf(QueryBy, input['by'])) {
    return refuse('`by` is not a known query kind');
  }
  for (const key of QUERY_TEXT_KEYS) {
    if (input[key] !== undefined && 'string' !== typeof input[key]) {
      return refuse(`\`${key}\` is not a string`);
    }
  }
  for (const key of QUERY_FLAG_KEYS) {
    if (input[key] !== undefined && 'boolean' !== typeof input[key]) {
      return refuse(`\`${key}\` is not a boolean`);
    }
  }
  const attrs = input['attrs'];
  if (attrs !== undefined) {
    if (!Array.isArray(attrs) || !attrs.every((a) => 'string' === typeof a)) {
      return refuse('`attrs` is not a list of attribute names');
    }
    const pair = attrs.find((a: string) => !isAttrName(a));
    if (pair !== undefined) {
      return refuse(
        `\`attrs\` takes attribute NAMES only, not \`name=value\` — got ${JSON.stringify(pair)}. ` +
          'It PROJECTS each attribute onto the match, it does not filter on it.',
      );
    }
  }
  const source = input['source'];
  if (source !== undefined) {
    const error = sourceError(source);
    if (error !== undefined) {
      return refuse(error);
    }
  }
  // Fresh objects and arrays, as zod outputs them: the caller never holds the input's own.
  const value: Fields = { ...input };
  if (Array.isArray(attrs)) {
    value['attrs'] = [...attrs];
  }
  if (isFields(source)) {
    value['source'] = { ...source };
  }
  return { ok: true, value };
}
