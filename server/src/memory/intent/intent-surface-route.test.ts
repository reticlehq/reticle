/**
 * A declare with `surface.route` is filed under that route (#2306).
 *
 * The `noSubject` answer tells the agent to declare again with `surface.route`. Some routes that an
 * agent sends gave no subject, so the agent did that and got the same `noSubject` again: the home
 * page `/`, a hash route (`#/settings`), and a full URL, which was filed under `http`. The tool text
 * also did not show that `surface` is an object, so agents sent it as a string and were refused.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ReticleTool } from '@reticlehq/core';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { advertisedConfig, advertisedTools } from '@/surface/mcp/mcp.js';
import { TOOL_SURFACE } from '@/surface/tools/tool-surface.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { INTENT_TOOLS } from './intent-tools.js';
import { subjectFor, UNSORTED_SUBJECT } from './intent-subject.js';

const intentTool = INTENT_TOOLS[0];

function deps(): ToolDeps {
  const { fs } = createMemoryFs();
  return {
    fs,
    reticleRoot: '/repo/.reticle',
    now: () => 1_000,
    sessions: {
      resolve: () => {
        throw new Error('no session');
      },
      count: () => 0,
    },
  } as unknown as ToolDeps;
}

type DeclareOut = { noSubject?: { ids: string[]; fix: string }; intents?: { subject?: string }[] };

async function declareWithRoute(route: string): Promise<DeclareOut> {
  return (await intentTool?.handler(deps(), {
    action: 'declare',
    intents: [
      { id: 'saved', statement: 'Saving a setting keeps it after a reload', surface: { route } },
    ],
  })) as DeclareOut;
}

describe('the subject of a route', () => {
  it.each([
    ['http://localhost:3000/settings', 'settings'],
    ['https://app.example.com/v1/billing?tab=2', 'billing'],
    ['#/settings', 'settings'],
    ['/#/settings/profile', 'settings'],
    ['http://localhost:5173/#/settings', 'settings'],
  ])('reads %j as %j', (route, subject) => {
    expect(subjectFor({ surface: { route } })).toBe(subject);
  });

  it('keeps the path before a hash when the path names an area', () => {
    expect(subjectFor({ surface: { route: '/admin/#/users' } })).toBe('admin');
  });

  it.each(['/', 'http://localhost:3000/', '/?tab=1', '#/', '/#/'])(
    'files the home page %j under "home"',
    (route) => {
      expect(subjectFor({ surface: { route } })).toBe('home');
    },
  );

  it('files the home page under its files, not under "home", when the intent names its code', () => {
    expect(subjectFor({ surface: { route: '/', files: ['src/billing/Pay.tsx'] } })).toBe('billing');
  });

  it('files the home page under its binding API path, not under "home"', () => {
    expect(
      subjectFor({
        surface: { route: '/' },
        binding: { kind: 'net', urlContains: '/api/billing' },
      }),
    ).toBe('api');
  });

  it('still leaves a route made only of ids unsorted', () => {
    expect(subjectFor({ surface: { route: '/123' } })).toBe(UNSORTED_SUBJECT);
  });
});

describe('a declare with surface.route', () => {
  it.each(['/', '#/settings', 'http://localhost:3000/settings'])(
    'with %j does not answer noSubject',
    async (route) => {
      const out = await declareWithRoute(route);
      expect(out.noSubject).toBeUndefined();
    },
  );

  it('with a route that names no area says to use surface.flow', async () => {
    const out = await declareWithRoute('/123');
    expect(out.noSubject?.ids).toEqual(['saved']);
    expect(out.noSubject?.fix).toContain('surface.flow');
    expect(out.noSubject?.fix).toContain('/123');
  });
});

describe('the advertised shape of surface', () => {
  it('shows that surface is an object, with an example', () => {
    const advertised = advertisedTools(TOOL_SURFACE.ALL);
    const tool = advertised.find((t) => ReticleTool.INTENT === t.name);
    expect(tool).toBeDefined();
    if (tool === undefined) {
      return;
    }
    const shape = advertisedConfig(tool, advertised, TOOL_SURFACE.ALL).inputSchema;
    // Unescaped, so the example reads as the client sees it.
    const json = JSON.stringify(z.toJSONSchema(z.object(shape))).replace(/\\"/g, '"');
    expect(json).toContain('{ route?, flow?, files? }');
    expect(json).toContain('"/settings"');
  });
});
