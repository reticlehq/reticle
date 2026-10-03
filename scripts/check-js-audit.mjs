/**
 * Fail CI on high/critical JavaScript advisories, with two reviewed exceptions for unpatched
 * development tools. An exception matches an advisory's exact version and sole dependency path;
 * another path, a patched release, or a new advisory still fails the gate.
 *
 * Remove each exception when its dependency can be updated. See .github/REPOSITORY-SETTINGS.md.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXCEPTIONS = new Map([
  [
    'GHSA-ch52-4w7c-c8xp',
    {
      package: 'http-cache-semantics',
      version: '4.2.0',
      path: 'apps__e2e>verdaccio>@verdaccio/hooks>got>cacheable-request>http-cache-semantics',
    },
  ],
  [
    'GHSA-vfj7-8cjw-p6xm',
    {
      package: 'braces',
      version: '3.0.3',
      path: '.>tsc-alias>chokidar>braces',
    },
  ],
]);
const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

function reviewDevelopmentRoots(root, e2e) {
  const failures = [];
  if (
    root.private !== true ||
    root.devDependencies?.['tsc-alias'] !== '^1.9.5' ||
    root.dependencies?.['tsc-alias'] !== undefined
  ) {
    failures.push('tsc-alias is no longer confined to the root development dependencies');
  }
  if (
    e2e.private !== true ||
    e2e.devDependencies?.verdaccio !== '6.10.4' ||
    e2e.dependencies?.verdaccio !== undefined
  ) {
    failures.push('Verdaccio is no longer confined to the private e2e development dependencies');
  }
  return failures;
}

function reviewAudit(report) {
  const failures = [];
  const accepted = new Set();
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { failures: ['audit output is not an object'], accepted };
  }
  if (report.advisories === null || typeof report.advisories !== 'object') {
    return { failures: ['audit output has no advisories object'], accepted };
  }
  if (!Array.isArray(report.muted) || report.muted.length > 0) {
    failures.push('audit output contains muted advisories or lacks the muted list');
  }

  for (const advisory of Object.values(report.advisories)) {
    if (advisory === null || typeof advisory !== 'object') {
      failures.push('audit output contains an invalid advisory');
      continue;
    }
    if (!SEVERITIES.has(advisory.severity)) {
      failures.push('audit output contains an unknown advisory severity');
      continue;
    }
    if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;
    const id = advisory.github_advisory_id;
    const exception = EXCEPTIONS.get(id);
    const findings = advisory.findings;
    const finding = Array.isArray(findings) && findings.length === 1 ? findings[0] : undefined;
    const exactPath =
      Array.isArray(finding?.paths) &&
      finding.paths.length === 1 &&
      finding.paths[0] === exception?.path;
    if (
      exception !== undefined &&
      !accepted.has(id) &&
      advisory.severity === 'high' &&
      advisory.module_name === exception.package &&
      advisory.patched_versions === '<0.0.0' &&
      finding?.version === exception.version &&
      exactPath
    ) {
      accepted.add(id);
      continue;
    }
    failures.push(
      `${String(id ?? advisory.module_name ?? 'unknown')}: unreviewed high/critical finding`,
    );
  }
  for (const id of EXCEPTIONS.keys()) {
    if (!accepted.has(id))
      failures.push(`${id}: exception is stale or its dependency path changed`);
  }
  return { failures, accepted };
}

function selfTest() {
  const root = { private: true, devDependencies: { 'tsc-alias': '^1.9.5' } };
  const e2e = { private: true, devDependencies: { verdaccio: '6.10.4' } };
  if (reviewDevelopmentRoots(root, e2e).length > 0) throw new Error('development roots rejected');
  if (
    reviewDevelopmentRoots({ ...root, dependencies: { 'tsc-alias': '^1.9.5' } }, e2e).length === 0
  )
    throw new Error('production dependency passed');
  const report = {
    muted: [],
    advisories: Object.fromEntries(
      [...EXCEPTIONS].map(([id, exception]) => [
        id,
        {
          github_advisory_id: id,
          severity: 'high',
          module_name: exception.package,
          patched_versions: '<0.0.0',
          findings: [{ version: exception.version, paths: [exception.path] }],
        },
      ]),
    ),
  };
  const clone = () => structuredClone(report);
  if (reviewAudit(report).failures.length !== 0) throw new Error('known paths were rejected');
  const newAdvisory = clone();
  newAdvisory.advisories.extra = { severity: 'critical', github_advisory_id: 'GHSA-new' };
  if (reviewAudit(newAdvisory).failures.length === 0) throw new Error('new advisory passed');
  const unknownSeverity = clone();
  unknownSeverity.advisories.extra = { severity: 'severe', github_advisory_id: 'GHSA-new' };
  if (reviewAudit(unknownSeverity).failures.length === 0)
    throw new Error('unknown severity passed');
  const newPath = clone();
  newPath.advisories['GHSA-vfj7-8cjw-p6xm'].findings[0].paths.push('.>other>braces');
  if (reviewAudit(newPath).failures.length === 0) throw new Error('new path passed');
  const patched = clone();
  patched.advisories['GHSA-ch52-4w7c-c8xp'].patched_versions = '4.2.1';
  if (reviewAudit(patched).failures.length === 0) throw new Error('patched advisory passed');
  const stale = clone();
  delete stale.advisories['GHSA-ch52-4w7c-c8xp'];
  if (reviewAudit(stale).failures.length === 0) throw new Error('stale exception passed');
  const muted = clone();
  muted.muted.push({ id: 'GHSA-hidden' });
  if (reviewAudit(muted).failures.length === 0) throw new Error('muted advisory passed');
  process.stdout.write('JavaScript audit exception self-test passed\n');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['audit', '--json'],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`pnpm audit did not return JSON: ${result.stderr || result.stdout}`);
  }
  const { failures, accepted } = reviewAudit(report);
  failures.push(
    ...reviewDevelopmentRoots(
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
      JSON.parse(readFileSync(new URL('../apps/e2e/package.json', import.meta.url), 'utf8')),
    ),
  );
  if (result.status !== 0 && result.status !== 1) {
    failures.push(`pnpm audit exited ${String(result.status)}: ${result.stderr}`);
  }
  for (const id of accepted) process.stdout.write(`Reviewed development-tool exception: ${id}\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('JavaScript high/critical audit passed\n');
  }
}
