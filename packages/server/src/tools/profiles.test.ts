import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import {
  CORE_TOOL_NAMES,
  TOOL_PROFILE,
  TOOL_PROFILE_ENV,
  filterTools,
  resolveToolProfile,
} from './profiles.js';

describe('tool profiles', () => {
  const original = process.env[TOOL_PROFILE_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[TOOL_PROFILE_ENV];
    else process.env[TOOL_PROFILE_ENV] = original;
  });
  beforeEach(() => {
    delete process.env[TOOL_PROFILE_ENV];
  });

  it('1: CORE filter returns exactly the core tool set', () => {
    const names = filterTools(TOOLS, TOOL_PROFILE.CORE).map((t) => t.name);
    expect(new Set(names)).toEqual(CORE_TOOL_NAMES);
    expect(names).toHaveLength(CORE_TOOL_NAMES.size);
  });

  it('2: FULL filter returns every tool (the full surface, ≥35)', () => {
    const tools = filterTools(TOOLS, TOOL_PROFILE.FULL);
    expect(tools).toHaveLength(TOOLS.length);
    expect(TOOLS.length).toBeGreaterThanOrEqual(35);
  });

  it('3: every CORE_TOOL_NAMES entry actually exists in TOOLS (no dangling name)', () => {
    const all = new Set(TOOLS.map((t) => t.name));
    for (const name of CORE_TOOL_NAMES) expect(all.has(name)).toBe(true);
  });

  it('4: CORE is a strict subset — fewer tools than FULL', () => {
    expect(CORE_TOOL_NAMES.size).toBeLessThan(TOOLS.length);
  });

  it('5: resolveToolProfile — explicit value wins over env', () => {
    process.env[TOOL_PROFILE_ENV] = TOOL_PROFILE.FULL;
    expect(resolveToolProfile(TOOL_PROFILE.CORE)).toBe(TOOL_PROFILE.CORE);
  });

  it('6: resolveToolProfile — falls back to env when no explicit value', () => {
    process.env[TOOL_PROFILE_ENV] = TOOL_PROFILE.CORE;
    expect(resolveToolProfile()).toBe(TOOL_PROFILE.CORE);
  });

  it('7: resolveToolProfile — defaults to FULL, and an unknown value fails open to FULL', () => {
    expect(resolveToolProfile()).toBe(TOOL_PROFILE.FULL);
    expect(resolveToolProfile('bogus')).toBe(TOOL_PROFILE.FULL);
  });
});
