import { describe, expect, it } from 'vitest';
import { spawnsHeadless } from './mcp-command.js';

/**
 * A second project's agent asked for the first project's port, was moved to a random one, and the
 * daemon it started there opened a visible browser nobody asked for.
 */
describe('the daemon a relocated MCP starts', () => {
  it('hides its browser when the port was not the one asked for', () => {
    expect(spawnsHeadless(false, 4401, 52247)).toBe(true);
  });

  it('keeps the default on the port that was asked for', () => {
    expect(spawnsHeadless(false, 4401, 4401)).toBe(false);
    expect(spawnsHeadless(true, 4401, 4401)).toBe(true);
  });
});
