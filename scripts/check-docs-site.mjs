#!/usr/bin/env node
/**
 * Post-deploy docs site gate: fetches every page listed in docs.json from the live site and fails
 * on any non-200. Derived from the navigation (not a filesystem walk) so it checks exactly what a
 * user can reach.
 *
 * Also checks the .md variant of each page (the agent reading path — what llms.txt links to) and
 * /llms.txt itself (the entry point for the whole agent path).
 *
 * Assumes the site returns a real 404 (not a 200 SPA shell) and answers HEAD. Both are true today
 * but neither is guaranteed by anything we control — if the host changes routing, this gate
 * silently stops catching broken pages.
 *
 * Usage:
 *   node scripts/check-docs-site.mjs [--base https://docs.reticle.sh]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE_URL = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'https://docs.reticle.sh';

const docsJsonPath = resolve(import.meta.dirname, '..', 'docs', 'docs.json');
const docsJson = JSON.parse(readFileSync(docsJsonPath, 'utf8'));

function extractPages(obj) {
  const pages = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === 'string') {
        pages.push(item);
      } else if (typeof item === 'object' && item !== null) {
        pages.push(...extractPages(item));
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    if (Array.isArray(obj.pages)) {
      pages.push(...extractPages(obj.pages));
    }
    if (Array.isArray(obj.groups)) {
      pages.push(...extractPages(obj.groups));
    }
    if (Array.isArray(obj.tabs)) {
      pages.push(...extractPages(obj.tabs));
    }
    if (Array.isArray(obj.versions)) {
      pages.push(...extractPages(obj.versions));
    }
  }
  return pages;
}

const allPages = [...new Set(extractPages(docsJson.navigation))];

if (allPages.length === 0) {
  console.error('No pages found in docs.json navigation — check the structure.');
  process.exit(1);
}

// The .md variant of each page is the agent reading path (what llms.txt links to). It is served
// by a different route, so a page can be fine and its .md broken — and the reader it breaks is
// the one we care most about.
const mdPages = allPages.map((page) => `${page}.md`);

// /llms.txt is the entry point for the whole agent path — if it 404s, every other page being
// green is beside the point.
const entryPoints = ['llms.txt'];

const allChecks = [...allPages, ...mdPages, ...entryPoints];

console.log(
  `Checking ${allPages.length} pages + ${mdPages.length} .md variants + ${entryPoints.length} entry point(s) against ${BASE_URL} ...\n`,
);

const failures = [];
const CONCURRENCY = 5;
let checked = 0;

async function checkPage(page) {
  const url = `${BASE_URL}/${page}`;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    checked++;
    if (res.status !== 200) {
      failures.push({ page, status: res.status });
      console.log(`  ✗ ${page} → ${res.status}`);
    } else {
      process.stdout.write(`\r  checked ${checked}/${allChecks.length}`);
    }
  } catch (err) {
    checked++;
    failures.push({ page, status: `error: ${err.message}` });
    console.log(`  ✗ ${page} → ${err.message}`);
  }
}

/**
 * The docs host generates an Agent Skill of its own at `/skill.md`, from the docs rather than from
 * the canonical `SKILL.md` in this repository. Nothing in `docs.json` lists it, so every other check
 * here is blind to it — and it is served from our domain, at the most guessable slug, to agents who
 * will follow it.
 *
 * Two things it must not do, and the reason for each:
 *
 *   - It must not be the ONLY thing an agent reads. It carries no `RETICLE_INSTALL_SOURCE` marker,
 *     so an install that follows it is attributed to nothing, and we cannot tell whether the route
 *     works. It must point at the canonical file.
 *   - It must not present one framework's dev-module path as THE path. `src/reticle-dev.ts` is
 *     where a Vite app puts it; a Next app puts it under `app/`. An agent told the wrong one looks
 *     for a file that is not there and concludes the install failed.
 *
 * Checked rather than assumed, because it is generated: it changes when the docs change, without a
 * commit that mentions it.
 */
const GENERATED_SKILL_PATH = '/skill.md';
/**
 * The repository slug rather than one spelling of one URL: the canonical file is reachable as
 * `raw.githubusercontent.com/reticlehq/reticle/...` and the repository as
 * `github.com/reticlehq/reticle`, and either is a route out. Matching a single full URL would go
 * red the day somebody links the other one, which is a check about a string rather than about
 * whether a reader can get to the real thing.
 */
const CANONICAL_SKILL_SLUG = 'reticlehq/reticle';

async function checkGeneratedSkill() {
  const url = `${BASE_URL}${GENERATED_SKILL_PATH}`;
  let body = '';
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      // A 404 is a PASS: the host is not publishing a skill we did not write.
      console.log(`  ✓ ${GENERATED_SKILL_PATH} → ${res.status} (not published)`);
      return;
    }
    body = await res.text();
  } catch (err) {
    failures.push({ page: GENERATED_SKILL_PATH, status: `error: ${err.message}` });
    return;
  }
  if (!body.includes(CANONICAL_SKILL_SLUG)) {
    failures.push({
      page: GENERATED_SKILL_PATH,
      status:
        'published, but never points at the canonical SKILL.md — an agent that reads it has no route to the real one',
    });
    return;
  }
  console.log(`  ✓ ${GENERATED_SKILL_PATH} → points at the canonical skill`);
}

async function run() {
  for (let i = 0; i < allChecks.length; i += CONCURRENCY) {
    const batch = allChecks.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(checkPage));
  }
  await checkGeneratedSkill();
  console.log('\n');
  if (failures.length > 0) {
    console.error(`${failures.length} page(s) did not return 200:\n`);
    for (const f of failures) {
      console.error(`  ${f.page} → ${f.status}`);
    }
    process.exit(1);
  }
  console.log(`All ${allChecks.length} URLs returned 200.`);
}

run();
