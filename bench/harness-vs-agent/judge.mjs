#!/usr/bin/env node
/**
 * Score benchmark runs against the app's ground truth.
 *
 *   BENCH_GROUND_TRUTH=…/GROUND-TRUTH.md node bench/harness-vs-agent/judge.mjs <run-dir>...
 *
 * A model reads one run's final report beside the ground-truth table and names the defect IDs the
 * report independently identified, each with a verbatim quote. The quote is then checked against
 * the report here, mechanically: a credit whose quote is not in the report is dropped, so the judge
 * cannot invent a finding. Writes `score.json` beside each run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const truthPath = process.env.BENCH_GROUND_TRUTH;
if (truthPath === undefined || !existsSync(truthPath)) throw new Error('set BENCH_GROUND_TRUTH');
const truth = readFileSync(truthPath, 'utf8');
const judgeModel = process.env.BENCH_JUDGE_MODEL ?? 'sonnet';
const ID = /^B\d{2}$/;

const squash = (s) => s.replace(/\s+/g, ' ').replace(/[`*_]/g, '').trim().toLowerCase();

function judge(report) {
  const prompt = [
    'You are scoring a QA report against a ground-truth list of defects in a web app.',
    'Credit a defect ID only when the report itself identifies that specific defect (same symptom on the same feature).',
    'A vague or different finding does not count. Known noise (N1-N3) never counts.',
    'Answer with ONLY a JSON object: {"found":[{"id":"B01","quote":"<verbatim sentence fragment from the REPORT, 8-25 words>"}]}',
    '',
    '=== GROUND TRUTH ===',
    truth,
    '',
    '=== REPORT ===',
    report,
  ].join('\n');
  const out = spawnSync(
    'claude',
    ['-p', prompt, '--model', judgeModel, '--output-format', 'json'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const text = JSON.parse(out.stdout || '{}').result ?? '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(json).found ?? [];
  } catch {
    return [];
  }
}

for (const dir of process.argv.slice(2)) {
  const metricsPath = join(dir, 'metrics.json');
  if (!existsSync(metricsPath)) continue;
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
  const report = metrics.report ?? '';
  const flat = squash(report);
  const claimed = judge(report);
  const found = [];
  const dropped = [];
  for (const c of claimed) {
    const ok =
      ID.test(String(c.id)) && 'string' === typeof c.quote && flat.includes(squash(c.quote));
    (ok ? found : dropped).push(c);
  }
  const ids = [...new Set(found.map((c) => c.id))].sort();
  writeFileSync(
    join(dir, 'score.json'),
    JSON.stringify({ judgeModel, found: ids, evidence: found, dropped }, null, 2),
  );
  console.log(
    `${dir}: ${String(ids.length)} defect(s) — ${ids.join(' ')}${dropped.length ? ` (${String(dropped.length)} unquoted credit(s) dropped)` : ''}`,
  );
}
