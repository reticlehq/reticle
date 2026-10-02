import { describe, expect, it } from 'vitest';
import { detectMcpClients } from './detect-clients.js';

function detect(files: Record<string, string>) {
  const relative = (path: string): string => path.replaceAll('\\', '/').replace('/fixture/', '');
  return detectMcpClients({
    homeDir: () => '/fixture',
    exists: (path) =>
      Object.keys(files).some(
        (file) => file === relative(path) || file.startsWith(`${relative(path)}/`),
      ),
    readFile: (path) => files[relative(path)] ?? null,
  }).map((client) => client.id);
}

describe('agents sharing a home directory', () => {
  it('does not infer Gemini CLI from an Antigravity-only profile', () => {
    expect(detect({ '.gemini/config/mcp_config.json': '{}' })).toEqual(['antigravity']);
  });

  it('detects both when each has its own config', () => {
    expect(
      detect({ '.gemini/settings.json': '{}', '.gemini/config/mcp_config.json': '{}' }),
    ).toEqual(['gemini', 'antigravity']);
  });

  it('still detects Gemini alone', () => {
    expect(detect({ '.gemini/settings.json': '{}' })).toEqual(['gemini']);
  });
});
