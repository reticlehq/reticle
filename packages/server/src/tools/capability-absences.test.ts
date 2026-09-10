import { describe, expect, it } from 'vitest';
import { capabilityAbsences } from './capability-absences.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

describe('what a session cannot do is reported, but only when it said so', () => {
  it('a healthy session declares nothing missing', () => {
    expect(capabilityAbsences({ captureBodies: true, sourceMapping: true })).toEqual([]);
  });

  it('silence is unknown, never a missing capability', () => {
    // An SDK older than the announcement sends neither field. Reporting an absence here would tell
    // every one of those sessions it cannot do something it can do perfectly well.
    expect(capabilityAbsences({})).toEqual([]);
  });

  it('bodies switched off is reported, with what it costs and how to turn it on', () => {
    const [absence] = capabilityAbsences({ captureBodies: false });
    expect(absence?.capability).toBe('network-bodies');
    expect(absence?.meaning).toContain('refused before it spends an action');
    expect(absence?.remedy).toContain('captureBodies: true');
  });

  it('source mapping switched off is reported, and says it is often on purpose', () => {
    const [absence] = capabilityAbsences({ sourceMapping: false });
    expect(absence?.capability).toBe('source-mapping');
    expect(absence?.meaning).toContain('which file and line');
    // Important: this one is NOT a fault. Telling an agent to "fix" a deliberate setting sends it
    // to change a config that is correct.
    expect(absence?.remedy).toContain('deliberate');
  });

  it('both off reports both, in a stable order', () => {
    expect(
      capabilityAbsences({ captureBodies: false, sourceMapping: false }).map((a) => a.capability),
    ).toEqual(['network-bodies', 'source-mapping']);
  });

  it('every absence answers all three questions', () => {
    // A named absence with no meaning or no remedy is a dead end: the agent knows something is wrong
    // and has nothing to do about it.
    for (const absence of capabilityAbsences({ captureBodies: false, sourceMapping: false })) {
      expect(absence.capability.length).toBeGreaterThan(0);
      expect(absence.meaning.length).toBeGreaterThan(20);
      expect(absence.remedy.length).toBeGreaterThan(20);
    }
  });
});

/**
 * The unit tests above prove the rule. This proves an agent can actually SEE it.
 *
 * A rule that is correct and unreachable is the failure this repository keeps finding in its own
 * guards, so the absence is read back through the real `reticle_capabilities` tool.
 */
describe('an agent asking what it can do is told what it cannot', () => {
  const capabilitiesTool = (): ToolDef => {
    const found = TOOLS.find((t) => t.name === ReticleTool.CAPABILITIES);
    if (found === undefined) throw new Error('reticle_capabilities is not on the surface');
    return found;
  };

  const deps = (facts: { captureBodies?: boolean; sourceMapping?: boolean }): ToolDeps => {
    const session = {
      id: 'demo',
      ...facts,
      command: () =>
        Promise.resolve({
          ok: true,
          result: { testids: [], signals: [], stores: [], flows: [] },
        }),
    } as unknown as Session;
    const sessions: Partial<SessionManager> = { resolve: () => session };
    return { sessions: sessions as SessionManager } as unknown as ToolDeps;
  };

  it('says nothing extra when nothing is switched off', async () => {
    const result = (await capabilitiesTool().handler(deps({ captureBodies: true }), {})) as {
      cannot?: unknown[];
    };
    // Absent, not an empty array: silence has to keep meaning "nothing is missing".
    expect(result.cannot).toBeUndefined();
  });

  it('reports the absence before the agent plans around it', async () => {
    const result = (await capabilitiesTool().handler(deps({ captureBodies: false }), {})) as {
      cannot?: { capability: string }[];
    };
    expect(result.cannot?.map((c) => c.capability)).toEqual(['network-bodies']);
  });
});
