/**
 * Path router for ci.yml `changes`.
 *
 * Incident #1514: a changed path that no rule in ci.yml's inline `changes` step matched turned
 * the expensive tiers OFF, and `gate` counts a skip as green -- a new `adapters/realm/<name>/`
 * matched the coarse `adapters/` allowlist while desktop/bench/conformance never turned on.
 * Fail-safe is now "matched no tier and is not docs-only": every tier on.
 *
 * Workspace packages add only `e2e` and `windows` from tier-map.json. install, desktop, bench,
 * conformance, gateself, break and launchers come from the narrow regexes in tier-patterns.json
 * alone. A package.json whose name is missing from the map turns every tier on, as does any
 * edit under .github/workflows/ or scripts/ci/.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PATTERNS = JSON.parse(readFileSync(join(HERE, 'tier-patterns.json'), 'utf8'));
const TIER_MAP = JSON.parse(readFileSync(join(HERE, 'tier-map.json'), 'utf8'));

export const TIERS = Object.keys(PATTERNS.tiers);

const compiled = Object.fromEntries(
  Object.entries(PATTERNS.tiers).map(([name, source]) => [name, new RegExp(source)]),
);
const docsOnly = new RegExp(PATTERNS.docsOnly);
const allTiersPrefix = new RegExp(PATTERNS.allTiersPrefix);

/** Every expensive tier on. Used for fail-safe and for workflow/router edits. */
export function allTiersOn() {
  return Object.fromEntries(TIERS.map((name) => [name, true]));
}

/** True when the path is cheap: docs, root markdown, issue templates. */
export function isDocsOnly(path) {
  return docsOnly.test(path);
}

/**
 * Nearest package.json above `path` whose name is a workspace package.
 *
 * @returns {{ name: string, mapped: boolean } | null}
 */
export function owningPackage(path, repoRoot = REPO) {
  let dir = path.includes('/') ? dirname(path) : '.';
  for (;;) {
    const relative = '.' === dir ? 'package.json' : join(dir, 'package.json');
    const abs = join(repoRoot, relative);
    if (existsSync(abs)) {
      const body = JSON.parse(readFileSync(abs, 'utf8'));
      const name = body.name;
      if ('string' === typeof name && 'reticle-monorepo' !== name) {
        return { name, mapped: name in TIER_MAP };
      }
    }
    if ('.' === dir) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function orTiers(flags, names) {
  for (const name of names) {
    if (name in flags) flags[name] = true;
  }
}

/**
 * Decide which expensive CI tiers a changed-path list turns on.
 *
 * @param {readonly string[]} paths
 * @returns {{ flags: Record<string, boolean>, unrouted: string[], unmapped: string[] }}
 */
export function route(paths) {
  const flags = Object.fromEntries(TIERS.map((name) => [name, false]));
  const unrouted = [];
  const unmapped = [];

  if (paths.some((path) => allTiersPrefix.test(path))) {
    return { flags: allTiersOn(), unrouted: [], unmapped: [] };
  }

  for (const path of paths) {
    if (isDocsOnly(path)) continue;
    let hit = false;
    const owner = owningPackage(path);
    if (null !== owner && !owner.mapped) {
      unmapped.push(`${path} (${owner.name})`);
      continue;
    }
    if (null !== owner && owner.mapped) {
      orTiers(flags, TIER_MAP[owner.name]);
      hit = true;
    }
    for (const name of TIERS) {
      const pattern = compiled[name];
      if (pattern !== undefined && pattern.test(path)) {
        flags[name] = true;
        hit = true;
      }
    }
    if (!hit) unrouted.push(path);
  }

  if (0 < unmapped.length) {
    return { flags: allTiersOn(), unrouted, unmapped };
  }
  if (0 < unrouted.length) {
    return { flags: allTiersOn(), unrouted, unmapped };
  }
  return { flags, unrouted, unmapped };
}

/** Markdown table of path -> tiers, for $GITHUB_STEP_SUMMARY. */
export function summaryTable(paths, result) {
  const lines = ['### CI path routing', '', '| path | tiers |', '| --- | --- |'];
  const unrouted = new Set(result.unrouted);
  const unmapped = new Set(result.unmapped);
  for (const path of paths) {
    if ([...unmapped].some((row) => row.startsWith(`${path} `))) {
      lines.push(`| \`${path}\` | ALL (unmapped package) |`);
      continue;
    }
    if (unrouted.has(path)) {
      lines.push(`| \`${path}\` | ALL (unrouted) |`);
      continue;
    }
    if (allTiersPrefix.test(path)) {
      lines.push(`| \`${path}\` | ALL (workflow/router) |`);
      continue;
    }
    if (isDocsOnly(path)) {
      lines.push(`| \`${path}\` | (docs-only) |`);
      continue;
    }
    const owner = owningPackage(path);
    const fromMap =
      null !== owner && owner.mapped
        ? (TIER_MAP[owner.name] ?? []).filter((name) => TIERS.includes(name))
        : [];
    const fromRegex = TIERS.filter((name) => compiled[name].test(path));
    const on = [...new Set([...fromMap, ...fromRegex])];
    lines.push(`| \`${path}\` | ${0 === on.length ? '(none)' : on.join(', ')} |`);
  }
  if (0 < result.unrouted.length) {
    lines.push('');
    lines.push('unrouted paths (fail-safe: every tier on):');
    for (const path of result.unrouted) lines.push(`- \`${path}\``);
  }
  if (0 < result.unmapped.length) {
    lines.push('');
    lines.push('unmapped packages (fail-safe: every tier on):');
    for (const row of result.unmapped) lines.push(`- \`${row}\``);
  }
  return `${lines.join('\n')}\n`;
}

function writeGithubOutput(flags) {
  const dest = process.env.GITHUB_OUTPUT;
  const body = `${TIERS.map((name) => `${name}=${flags[name]}`).join('\n')}\n`;
  if (undefined === dest || '' === dest) {
    process.stdout.write(body);
    return;
  }
  appendFileSync(dest, body);
}

function main(argv, stdin) {
  if (argv.includes('--dump-patterns')) {
    for (const [name, source] of Object.entries(PATTERNS.tiers)) {
      process.stdout.write(`${name}=${source}\n`);
    }
    return 0;
  }

  const paths = stdin
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => 0 < line.length);
  const result = route(paths);
  writeGithubOutput(result.flags);
  if (0 < result.unrouted.length) {
    console.log('unrouted paths (fail-safe: every tier on):');
    for (const path of result.unrouted) console.log(`  ${path}`);
  }
  if (0 < result.unmapped.length) {
    console.log('unmapped packages (fail-safe: every tier on):');
    for (const row of result.unmapped) console.log(`  ${row}`);
  }
  if (argv.includes('--summary')) {
    const table = summaryTable(paths, result);
    const step = process.env.GITHUB_STEP_SUMMARY;
    if (undefined !== step && '' !== step) appendFileSync(step, table);
    else process.stdout.write(table);
  }
  return 0;
}

const invoked =
  undefined !== process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  const stdin = readFileSync(0, 'utf8');
  process.exitCode = main(process.argv.slice(2), stdin);
}
