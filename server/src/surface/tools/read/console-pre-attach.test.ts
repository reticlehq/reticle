import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { projectConsoleLog } from '@reticlehq/engine/window/event-filters.js';
import { withPreAttach } from './console-pre-attach.js';

const ev = (data: Record<string, unknown>): ReticleEvent => ({
  t: 1,
  type: EventType.ERROR_UNCAUGHT,
  sessionId: 's',
  data,
});

describe('a console line raised before the SDK attached (#1540)', () => {
  it('says so, and says what the full buffer did not keep', () => {
    const e = ev({
      message: '<script> failed to load: /src/main.tsx',
      source: '/src/main.tsx',
      kind: 'resource',
      preAttach: true,
      droppedPreAttach: 4,
    });
    expect(withPreAttach(projectConsoleLog(e), e)).toEqual({
      level: 'error',
      text: '<script> failed to load: /src/main.tsx',
      source: '/src/main.tsx',
      preAttach: true,
      droppedPreAttach: 4,
    });
  });

  it('adds nothing to a line the SDK heard itself', () => {
    const e = ev({ message: 'later', droppedPreAttach: 0, preAttach: 'yes' });
    const view = withPreAttach(projectConsoleLog(e), e);
    expect(view).toEqual({ level: 'error', text: 'later' });
  });
});
