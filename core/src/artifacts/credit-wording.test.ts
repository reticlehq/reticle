/**
 * Credits pay for the whole platform, and every surface says so in one word: credits.
 *
 * Shipped defect: the HUD's account menu offered "500 Harness credits", the CLI and MCP text said
 * "Harness credits", and the docs said "every plan includes Harness credits". The trial's 500
 * credits cover everything, so each of those sentences told a customer the wrong thing about what
 * they pay for. Credits are a count, never dollars, so "$" beside a credit count is wrong too.
 *
 * Reads the shipped source and the user docs; tests are skipped, since they may quote an old string.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIGN_UP_PITCH, TRIAL_OFFER } from './harness-credits.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = [
  'core/src',
  'server/src',
  'server/package.json',
  'init/src',
  'adapters/realm/browser/src',
  'docs',
  'plugin',
  'skills',
  'SKILL.md',
  'llms.txt',
  'MIGRATION.md',
  'README.md',
];
const TEXT = /\.(ts|tsx|md|mdx|txt|json)$/;
const SKIPPED = /(\.test\.|node_modules|[/\\]dist[/\\])/;
const WRONG = [/harness credits?/i, /\$\s?\d[\d,.]*\s*(free |trial )?credits?/i];

function files(path: string): string[] {
  const full = join(REPO, path);
  if (statSync(full, { throwIfNoEntry: false }) === undefined) return [];
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full).flatMap((name) => files(join(path, name)));
}

describe('credits are credits, for the whole platform', () => {
  it('says the trial grant as plain credits', () => {
    expect(TRIAL_OFFER).toContain('500 credits');
    for (const text of [SIGN_UP_PITCH, TRIAL_OFFER]) {
      for (const wrong of WRONG) expect(text).not.toMatch(wrong);
    }
  });

  it('never calls them Harness credits or prices them in dollars, anywhere it ships', () => {
    const found = SCANNED.flatMap(files)
      .filter((path) => TEXT.test(path) && !SKIPPED.test(path))
      .flatMap((path) =>
        readFileSync(join(REPO, path), 'utf8')
          .split('\n')
          .flatMap((line, i) =>
            WRONG.some((wrong) => wrong.test(line))
              ? [`${relative(REPO, join(REPO, path))}:${String(i + 1)}`]
              : [],
          ),
      );
    expect(found).toEqual([]);
  });
});
