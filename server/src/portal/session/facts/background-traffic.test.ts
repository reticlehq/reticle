import { describe, expect, it } from 'vitest';
import { readBackgroundTraffic } from './background-traffic.js';

describe('readBackgroundTraffic — the endpoints a project says its app fires on its own', () => {
  it('reads the declared list', () => {
    expect(readBackgroundTraffic({ background: ['/api/analytics/events', '/api/ping'] })).toEqual([
      '/api/analytics/events',
      '/api/ping',
    ]);
  });

  it('is empty when nothing is declared, or the block is not a list', () => {
    expect(readBackgroundTraffic(undefined)).toEqual([]);
    expect(readBackgroundTraffic({})).toEqual([]);
    expect(readBackgroundTraffic({ background: '/api/ping' })).toEqual([]);
  });

  // A pattern that matches every request would exclude the app's real work from every verdict. An
  // entry too short to name an endpoint is dropped rather than obeyed; the rest of the list stands.
  it('drops an entry that would match everything, and keeps the rest', () => {
    expect(readBackgroundTraffic({ background: ['', '/', '//', 42, '/api/ping'] })).toEqual([
      '/api/ping',
    ]);
  });
});
