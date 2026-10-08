#!/usr/bin/env node
/**
 * One table of every scored run under a directory: defects found, checks, cost and time per arm.
 *
 *   node bench/harness-vs-agent/report.mjs [bench/artifacts/harness-vs-agent]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'bench/artifacts/harness-vs-agent');
const rows = readdirSync(root)
  .sort()
  .flatMap((name) => {
    const dir = join(root, name);
    if (!existsSync(join(dir, 'metrics.json'))) return [];
    const m = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'));
    const s = existsSync(join(dir, 'score.json'))
      ? JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'))
      : undefined;
    return [{ name, m, s }];
  });

console.log(
  '| run | arm | defects | IDs | checks yes/no/undecided | wrong guesses | agent $ | tool calls | wall |',
);
console.log('| --- | --- | --: | --- | --- | --: | --: | --: | --: |');
for (const { name, m, s } of rows) {
  const c = m.checks;
  console.log(
    `| ${name.slice(0, 19)} | ${m.arm} | ${s === undefined ? 'unscored' : String(s.found.length)} | ${s?.found.join(' ') ?? ''} | ${String(c.yes)}/${String(c.no)}/${String(c.undecided)} | ${String(c.wrongGuesses)} | ${m.agentCostUsd === null ? '' : Number(m.agentCostUsd).toFixed(2)} | ${String(m.toolCalls)} | ${String(Math.round(m.wallMs / 1000))}s |`,
  );
}
