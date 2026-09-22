import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '@/machine/repo-root.js';

/**
 * The HTTP transport has its own page. The places an agent reads when `reticle_*` is missing
 * from the catalog did not point at it, so the agents who needed it found the endpoints by
 * reading the server. Both of those pages have to name the path.
 */
const PAGES = [
  'docs/troubleshooting.mdx',
  'skills/install-and-verify/references/troubleshooting.md',
];

describe('an empty tool catalog points at the HTTP transport', () => {
  it('names /mcp/sse on the troubleshooting pages', () => {
    for (const rel of PAGES) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(text, rel).toContain('/mcp/sse');
      expect(text, rel).toMatch(/tool list is empty/i);
    }
  });
});
