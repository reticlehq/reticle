/**
 * Every `reticle_run { … }` a hint tells an agent to send must be a call reticle_run accepts.
 *
 * The hints for a throttled tab, a hover and a command timeout all said
 * `reticle_run { tool: "reticle_lease", action: "acquire", url }`. reticle_run refuses a key beside
 * `tool`/`args`/`sessionId` ("Unknown parameters for reticle_run: action, url"), so an agent that
 * followed the recovery EXACTLY spent its retry on a refusal — the advice was the defect. The working
 * shape is `{ tool, args: { … } }`.
 *
 * So each example is parsed out of the text we actually ship and checked against the REAL reticle_run
 * input schema, and its `args` against the named tool's own schema.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as core from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { RECOVERY } from './error-recovery.js';
import { buildDynamicTools } from './dynamic-tools.js';
import { TOOLS } from './tools.js';

/** A value the example leaves to the reader: `url`, `…`, `"..."`. Never checked, only its key. */
const PLACEHOLDER = Symbol('placeholder');
type Literal = string | typeof PLACEHOLDER | Literal[] | { [key: string]: Literal };

const TOKEN = /\s*(\{|\}|\[|\]|:|,|\.\.\.|…|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*|[^\s{}[\]:,"]+)/y;

/** Parse the object literal at the start of `text`, JS-ish: bare keys, shorthand, placeholders. */
function parseLiteral(text: string): { value: Literal; end: number } {
  const tokens: { t: string; end: number }[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); null !== m; m = TOKEN.exec(text)) {
    tokens.push({ t: m[1] ?? '', end: TOKEN.lastIndex });
  }
  let i = 0;
  const peek = (): string => tokens[i]?.t ?? '';
  const next = (): string => tokens[i++]?.t ?? '';
  const value = (): Literal => {
    const t = next();
    if ('{' === t) return object();
    if ('[' === t) {
      const items: Literal[] = [];
      while ('' !== peek() && ']' !== peek()) {
        if (',' === peek()) next();
        else items.push(value());
      }
      next();
      return items;
    }
    if (t.startsWith('"')) {
      const s = String(JSON.parse(t));
      return '...' === s || '…' === s ? PLACEHOLDER : s;
    }
    return PLACEHOLDER;
  };
  const object = (): Literal => {
    const out: { [key: string]: Literal } = {};
    while ('' !== peek() && '}' !== peek()) {
      const t = next();
      if (',' === t || '...' === t || '…' === t) continue;
      const key = t.startsWith('"') ? String(JSON.parse(t)) : t;
      if (':' === peek()) {
        next();
        out[key] = value();
      } else {
        out[key] = PLACEHOLDER; // shorthand: `{ tool, args }`
      }
    }
    next();
    return out;
  };
  if ('{' !== next()) throw new Error(`not an object literal: ${text.slice(0, 40)}`);
  const parsed = object();
  return { value: parsed, end: tokens[i - 1]?.end ?? text.length };
}

const CALL = /reticle_run\s*\(?\s*(?=\{)/g;

/** Every `reticle_run { … }` / `reticle_run({ … })` example in a piece of prose. */
function examplesIn(text: string): { source: string; value: Literal }[] {
  const found: { source: string; value: Literal }[] = [];
  for (const m of text.matchAll(CALL)) {
    const start = (m.index ?? 0) + m[0].length;
    const { value, end } = parseLiteral(text.slice(start));
    found.push({ source: text.slice(m.index ?? 0, start + end), value });
  }
  return found;
}

const isObject = (v: Literal): v is { [key: string]: Literal } =>
  'object' === typeof v && null !== v && !Array.isArray(v);

/** The literal with every placeholder dropped, so only what the example states is validated. */
function stated(v: Literal): unknown {
  if (Array.isArray(v)) return v.filter((x) => PLACEHOLDER !== x).map(stated);
  if (!isObject(v)) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => PLACEHOLDER !== x)
      .map(([k, x]) => [k, stated(x)]),
  );
}

const run = buildDynamicTools([...TOOLS]).find((t) => ReticleTool.RUN === t.name);
const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** The prose an agent is handed: every recovery hint, every shipped core string, every description. */
const shipped: { where: string; text: string }[] = [
  ...Object.entries(RECOVERY).map(([k, text]) => ({ where: `RECOVERY.${k}`, text })),
  ...Object.entries(core)
    .filter((e): e is [string, string] => 'string' === typeof e[1])
    .map(([k, text]) => ({ where: `@reticlehq/core ${k}`, text })),
  ...TOOLS.map((t) => ({ where: `${t.name} description`, text: t.description })),
];
const examples = shipped.flatMap(({ where, text }) =>
  examplesIn(text).map((e) => ({ where, ...e })),
);

describe('the reticle_run calls our hints tell an agent to make', () => {
  it('finds the examples it is checking (a parser that finds none proves nothing)', () => {
    expect(run).toBeDefined();
    expect(examples.some((e) => e.where.startsWith('RECOVERY.'))).toBe(true);
    expect(examples.some((e) => e.source.includes('reticle_lease'))).toBe(true);
  });

  it.each(examples.map((e) => [e.where, e.source, e.value] as const))(
    '%s: %s',
    (_where, source, value) => {
      expect(isObject(value), source).toBe(true);
      if (!isObject(value) || undefined === run) return;
      const allowed = Object.keys(run.inputSchema);
      for (const key of Object.keys(value)) expect(allowed, `${source}: ${key}`).toContain(key);
      const tool = value['tool'];
      if ('string' !== typeof tool) return; // `{ tool, args }` names the shape, not a call
      expect(z.object(run.inputSchema).strict().safeParse(stated(value)).success, source).toBe(
        true,
      );
      const target = byName.get(tool);
      expect(target, `${source}: no tool named ${tool}`).toBeDefined();
      const args = value['args'];
      if (undefined === target || undefined === args || !isObject(args)) return;
      const params = Object.keys(target.inputSchema);
      for (const key of Object.keys(args)) expect(params, `${source}: args.${key}`).toContain(key);
    },
  );
});
