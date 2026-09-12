import { describe, it, expect } from 'vitest';
import { ChannelId } from '../vocabulary/channel.js';
import { CompilePhase, compileFor, portableAcross } from './phases.js';

/**
 * The four phases, named — and portability as a CHECK rather than a claim.
 *
 * Most of this pipeline already existed and was unnamed: resolving anchors is the link step,
 * `CompiledProgram` is the emit step, and `Realm.dispatch` returning "delivered, nothing more" is
 * already a target machine refusing to interpret. Naming them is what makes the boundary checkable:
 * a stage that has no name is a stage nobody can point at when meaning leaks into the realm.
 *
 * The order is the whole content. TYPECHECK sits before EMIT because a program that cannot run must
 * not be built; emitting first and discovering later is precisely the runtime failure this phase was
 * added to prevent.
 */
const web = {
  capabilities: ['click', 'type'],
  channels: [ChannelId.UI, ChannelId.NET],
};
const mobile = {
  capabilities: ['tap', 'swipe'],
  channels: [ChannelId.UI],
};

describe('the compile phases', () => {
  it('runs parse -> resolve -> typecheck -> emit, in that order', () => {
    expect(Object.values(CompilePhase)).toEqual(['parse', 'resolve', 'typecheck', 'emit']);
  });

  it('emits a program when the document typechecks', () => {
    const out = compileFor([{ capability: 'click', reads: [ChannelId.UI] }], web);
    expect(out.ok).toBe(true);
    expect(out.ok ? out.program : []).toHaveLength(1);
  });

  it('stops at TYPECHECK and emits NOTHING when the realm cannot run it', () => {
    const out = compileFor([{ capability: 'swipe' }], web);
    expect(out.ok).toBe(false);
    expect(out.ok ? undefined : out.failedAt).toBe(CompilePhase.TYPECHECK);
    // The point of the phase: a program that cannot run is never built.
    expect(out).not.toHaveProperty('program');
  });
});

describe('portability is a check, not a claim', () => {
  const flow = [{ capability: 'click', reads: [ChannelId.UI] }];

  it('says a document is portable to a realm whose instruction set covers it', () => {
    expect(portableAcross(flow, { web }).web?.portable).toBe(true);
  });

  it('names what is MISSING rather than saying no', () => {
    const report = portableAcross(flow, { mobile });
    expect(report.mobile?.portable).toBe(false);
    expect((report.mobile?.missing ?? []).join(' ')).toContain('click');
  });

  it('answers for several realms at once, so one read settles where a flow runs', () => {
    const report = portableAcross(flow, { web, mobile });
    expect(report.web?.portable).toBe(true);
    expect(report.mobile?.portable).toBe(false);
  });
});
