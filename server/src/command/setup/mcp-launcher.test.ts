import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, mcpLauncher } from './mcp-launcher.js';

describe('the MCP launcher', () => {
  // A wrong relative path registers a launcher that does not exist, and the agent gets no tools.
  it('names the bin that this package ships', () => {
    expect(existsSync(CLI_BIN)).toBe(true);
    expect(CLI_BIN.replace(/\\/g, '/')).toMatch(/\/bin\/reticle\.js$/);
  });

  it('registers no source checkout as an install', () => {
    expect(mcpLauncher()).toBeUndefined();
  });
});
