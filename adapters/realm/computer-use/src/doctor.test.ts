import { describe, expect, it } from 'vitest';

import { doctorReport } from './doctor.js';
import type { DoctorFacts } from './doctor.js';

const ready: DoctorFacts = {
  platform: 'darwin',
  compiler: true,
  trusted: true,
  app: 'Notes',
  appOpen: true,
  windows: 1,
  windowsNotOnScreen: 0,
  bridge: true,
  token: true,
};

describe('doctorReport', () => {
  it('says that everything is ready, with one line for each check', () => {
    const report = doctorReport(ready);
    expect(report.ready).toBe(true);
    expect(report.lines.every((line) => line.startsWith('ok'))).toBe(true);
    expect(report.lines).toHaveLength(5);
  });

  it('names the exact place to give the permission', () => {
    const report = doctorReport({ ...ready, trusted: false });
    expect(report.ready).toBe(false);
    expect(report.lines.join('\n')).toContain('System Settings, Privacy & Security, Accessibility');
  });

  it('tells a closed window from a window on another Space', () => {
    const elsewhere = doctorReport({ ...ready, windows: 0, windowsNotOnScreen: 2 });
    expect(elsewhere.ready).toBe(false);
    expect(elsewhere.lines.join('\n')).toContain('another Space');
    const closed = doctorReport({ ...ready, windows: 0, windowsNotOnScreen: 0 });
    expect(closed.lines.join('\n')).toContain('has no window');
  });

  it('stops at the first thing that makes the later checks mean nothing', () => {
    const report = doctorReport({ ...ready, platform: 'linux' });
    expect(report.ready).toBe(false);
    expect(report.lines).toHaveLength(1);
    const closed = doctorReport({ ...ready, appOpen: false, windows: undefined });
    expect(closed.lines.join('\n')).toContain('Open Notes');
  });

  it('says how to start the daemon when the bridge does not answer', () => {
    const report = doctorReport({ ...ready, bridge: false });
    expect(report.ready).toBe(false);
    expect(report.lines.join('\n')).toContain('reticle serve');
  });
});
