import { describe, expect, it } from 'vitest';
import { Framework } from './detect.js';
import { DEV_SERVER_PORTS, frameworkDevPort } from './dev-server-ports.js';

describe('frameworkDevPort', () => {
  it("gives each framework's own default", () => {
    expect(frameworkDevPort(Framework.VITE)).toBe(5173);
    expect(frameworkDevPort(Framework.NEXT)).toBe(3000);
    expect(frameworkDevPort(Framework.ASTRO)).toBe(4321);
    expect(frameworkDevPort(Framework.ANGULAR)).toBe(4200);
  });

  it('is undefined for a framework with no dev server of its own', () => {
    expect(frameworkDevPort(Framework.HTML)).toBeUndefined();
  });

  it('only names ports the dev-server table already knows, so there is one list', () => {
    for (const framework of Object.values(Framework)) {
      const port = frameworkDevPort(framework);
      if (port !== undefined) expect(DEV_SERVER_PORTS.has(port)).toBe(true);
    }
  });
});
