import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encodeResult, withSessionEnvelope } from './mcp.js';
import { TOOLS } from './tools/tools.js';
import { SESSION_BOUND_TOOLS } from './tools/invoke-tool.js';
import { ReticleTool } from './tools/tool-names.js';

describe('withSessionEnvelope — spliced fields survive structuredContent validation', () => {
  const ENVELOPE_KEYS = ['session', 'session_lease', 'session_age_warning', 'control'];

  it('every session-bound tool with an outputSchema declares the envelope fields (superset guard)', () => {
    for (const tool of TOOLS) {
      if (tool.outputSchema === undefined || !SESSION_BOUND_TOOLS.has(tool.name)) continue;
      const merged = withSessionEnvelope(tool.name, tool.outputSchema) ?? {};
      for (const key of ENVELOPE_KEYS) {
        expect(Object.keys(merged), `${tool.name} must keep '${key}'`).toContain(key);
      }
    }
  });

  it("keeps a tool's own field shape over the permissive envelope default (ACT session)", () => {
    const act = TOOLS.find((t) => t.name === ReticleTool.ACT);
    const merged = withSessionEnvelope(ReticleTool.ACT, act?.outputSchema) ?? {};
    // ACT declares a typed session object; the merge must not overwrite it with z.unknown().
    expect(merged['session']).toBe(act?.outputSchema?.['session']);
  });

  it('leaves a non-session-bound tool schema untouched', () => {
    const shape: z.ZodRawShape = { ok: z.boolean() };
    expect(withSessionEnvelope('not_a_session_tool', shape)).toBe(shape);
  });
});

describe('encodeResult', () => {
  const result = { calls: [{ method: 'GET', url: '/api/x', status: 500 }] };

  it('defaults to compact JSON (no indentation whitespace)', () => {
    const text = encodeResult(result, '');
    expect(text).toBe('{"calls":[{"method":"GET","url":"/api/x","status":500}]}');
    expect(text).not.toContain('\n');
  });

  it('compact is strictly smaller than the pretty form for a structured payload', () => {
    expect(encodeResult(result, '').length).toBeLessThan(encodeResult(result, 'pretty').length);
  });

  it('opts back into indented JSON with encoding "pretty"', () => {
    const text = encodeResult(result, 'pretty');
    expect(text).toBe(JSON.stringify(result, null, 2));
    expect(text).toContain('\n');
  });

  it('round-trips to the same value regardless of encoding', () => {
    expect(JSON.parse(encodeResult(result, ''))).toEqual(result);
    expect(JSON.parse(encodeResult(result, 'pretty'))).toEqual(result);
  });
});
