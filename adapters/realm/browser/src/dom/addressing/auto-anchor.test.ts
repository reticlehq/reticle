import { describe, expect, it } from 'vitest';
import { synthesizeAnchor, AnchorStrategy } from './auto-anchor.js';

describe('synthesizeAnchor — durable addressing without a hand-added testid', () => {
  it('prefers an explicit testid above everything (stable)', () => {
    const a = synthesizeAnchor({
      testid: 'new-deploy',
      component: 'NewDeployButton',
      source: { file: 'src/Deployments.tsx', line: 107 },
      role: 'button',
      name: 'New deploy',
    });
    expect(a).toEqual({ strategy: AnchorStrategy.TESTID, value: 'new-deploy', stable: true });
  });

  it('falls back to component@source when no testid (stable, source basename only)', () => {
    const a = synthesizeAnchor({
      component: 'NewDeployButton',
      source: { file: 'src/views/Deployments.tsx', line: 107 },
      role: 'button',
      name: 'New deploy',
    });
    expect(a.strategy).toBe(AnchorStrategy.COMPONENT);
    expect(a.value).toBe('NewDeployButton@Deployments.tsx:107');
    expect(a.stable).toBe(true);
  });

  it('uses component + accessible name when source is unavailable (still stable)', () => {
    const a = synthesizeAnchor({
      component: 'NewDeployButton',
      role: 'button',
      name: 'New deploy',
    });
    expect(a.strategy).toBe(AnchorStrategy.COMPONENT);
    expect(a.value).toBe('NewDeployButton[New deploy]');
    expect(a.stable).toBe(true);
  });

  it('role + name is addressable but NOT stable (a name can change with copy)', () => {
    const a = synthesizeAnchor({ role: 'button', name: 'New deploy' });
    expect(a.strategy).toBe(AnchorStrategy.ROLE);
    expect(a.value).toBe('button:New deploy');
    expect(a.stable).toBe(false);
  });

  it('role only uses the positional tiebreaker and is not stable', () => {
    const a = synthesizeAnchor({ role: 'button', nth: 3 });
    expect(a.strategy).toBe(AnchorStrategy.ROLE);
    expect(a.value).toBe('button#3');
    expect(a.stable).toBe(false);
  });

  it('always returns something addressable — position as the last resort', () => {
    const a = synthesizeAnchor({ nth: 2 });
    expect(a.strategy).toBe(AnchorStrategy.POSITION);
    expect(a.value).toBe('el#2');
    expect(a.stable).toBe(false);
  });

  it('empty strings are ignored, not treated as present', () => {
    const a = synthesizeAnchor({ testid: '', component: '', role: 'link', name: 'Home' });
    expect(a.strategy).toBe(AnchorStrategy.ROLE);
    expect(a.value).toBe('link:Home');
  });
});
