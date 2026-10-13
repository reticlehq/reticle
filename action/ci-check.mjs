#!/usr/bin/env node
/**
 * The GitHub Action's one step: replay the journeys, post one verdict per journey to the platform,
 * and fail the job on a `no` or on a trial that needs a card.
 *
 * No dependencies, so the action needs nothing installed beyond Reticle itself. The decisions are
 * the exported functions, which `ci-check.test.mjs` drives with no network and no browser; `main`
 * is only the wiring around them.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FLOWS_DIR = join('.reticle', 'flows');
const RESULTS_FILE = 'reticle-results.json';
const SUITE_PATH = '/v1/ci/suite';
const CHECKS_PATH = '/v1/ci/checks';
const PAYMENT_REQUIRED = 402;
const VERDICT_NO = 'no';
const DEFAULT_CLOUD = 'https://app.reticle.sh';
const DEFAULT_BIN = ['npx', '-y', '@reticlehq/server@latest'];

/** The pull request number, from the event GitHub wrote to disk, or undefined off a PR. */
export function prNumber(event) {
  const number = event?.pull_request?.number ?? event?.number;
  return Number.isInteger(number) ? number : undefined;
}

/** The body `POST /v1/ci/checks` takes. */
export function checkPayload({ env, url, results, event }) {
  const pr = prNumber(event);
  return {
    repo: env.GITHUB_REPOSITORY ?? '',
    sha: env.GITHUB_SHA ?? '',
    ...(pr === undefined ? {} : { pr }),
    ...(env.GITHUB_REF === undefined ? {} : { ref: env.GITHUB_REF }),
    url,
    results,
  };
}

/** The per-journey verdicts `reticle verify --results-json` wrote, or none when it wrote nothing. */
export function readResults(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

/** The flows a `GET /v1/ci/suite` answer holds: a bare array, or `{ flows }` / `{ journeys }`. */
export function suiteFlows(body) {
  const list = Array.isArray(body) ? body : (body?.flows ?? body?.journeys ?? []);
  return Array.isArray(list)
    ? list.filter((flow) => typeof flow?.name === 'string' && flow.name.length > 0)
    : [];
}

/** A flow name as a file name: nothing that could leave the flows directory. */
export function flowFileName(name) {
  return `${name.replace(/[^\w-]+/g, '-')}.json`;
}

/**
 * What the job says and how it ends, from what the platform answered.
 *
 * Fails on `no`, on a trial that needs a card, on a platform that refused, and on a run that verified
 * nothing at all: zero journeys is never a green check.
 */
export function decide({ status, body, resultCount }) {
  if (status === PAYMENT_REQUIRED) {
    return {
      code: 1,
      lines: [body?.message ?? 'The Reticle trial needs a card to keep running checks.'],
    };
  }
  if (status < 200 || status >= 300) {
    return {
      code: 1,
      lines: [
        `The Reticle platform answered ${status}: ${body?.message ?? body?.error ?? ''}`.trim(),
      ],
    };
  }
  const lines = [
    `Reticle verdict: ${body?.verdict ?? 'unknown'}`,
    ...(body?.detailsUrl === undefined ? [] : [`Details: ${body.detailsUrl}`]),
  ];
  if (body?.verdict === VERDICT_NO) return { code: 1, lines };
  if (resultCount === 0) return { code: 1, lines: [...lines, 'No journey was verified.'] };
  return { code: 0, lines };
}

function hasFlows() {
  return existsSync(FLOWS_DIR) && readdirSync(FLOWS_DIR).some((f) => f.endsWith('.json'));
}

async function pullSuite(cloud, key, project) {
  const query = project.length > 0 ? `?projectId=${encodeURIComponent(project)}` : '';
  const res = await fetch(`${cloud}${SUITE_PATH}${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.log(`No .reticle/flows here, and the platform suite answered ${res.status}.`);
    return 0;
  }
  const flows = suiteFlows(await res.json());
  mkdirSync(FLOWS_DIR, { recursive: true });
  for (const flow of flows) {
    writeFileSync(join(FLOWS_DIR, flowFileName(flow.name)), `${JSON.stringify(flow, null, 2)}\n`);
  }
  console.log(`Pulled ${flows.length} journey(s) from the project suite.`);
  return flows.length;
}

async function main(env) {
  const url = env.RETICLE_ACTION_URL ?? '';
  const key = env.RETICLE_API_KEY ?? '';
  const cloud = (env.RETICLE_CLOUD_URL || DEFAULT_CLOUD).replace(/\/+$/, '');
  if (url.length === 0 || key.length === 0) {
    console.error('The Reticle action needs both `url` and `api-key`.');
    return 1;
  }
  if (!hasFlows()) await pullSuite(cloud, key, env.RETICLE_PROJECT ?? '');

  const resultsPath = join(env.RUNNER_TEMP ?? '.', RESULTS_FILE);
  const [cmd, ...pre] = env.RETICLE_BIN ? [env.RETICLE_BIN] : DEFAULT_BIN;
  spawnSync(cmd, [...pre, 'verify', url, '--results-json', resultsPath], {
    stdio: 'inherit',
    env,
  });
  const results = existsSync(resultsPath) ? readResults(readFileSync(resultsPath, 'utf8')) : [];
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};

  const res = await fetch(`${cloud}${CHECKS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(checkPayload({ env, url, results, event })),
  });
  const body = await res.json().catch(() => ({}));
  const outcome = decide({ status: res.status, body, resultCount: results.length });
  for (const line of outcome.lines) console.log(line);
  if (env.GITHUB_OUTPUT && typeof body?.detailsUrl === 'string') {
    appendFileSync(env.GITHUB_OUTPUT, `details-url=${body.detailsUrl}\n`);
  }
  return outcome.code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        `Reticle check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
