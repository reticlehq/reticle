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
const STORAGE_STATE_FILE = 'reticle-preview-state.json';
const DEPLOYMENT_SUCCESS = 'success';
const BYPASS_HEADER = 'x-vercel-protection-bypass';
const SET_BYPASS_COOKIE_HEADER = 'x-vercel-set-bypass-cookie';
const PROTECTED_STATUSES = new Set([401, 403]);
const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' };
const SESSION_COOKIE = -1;

export const NO_URL =
  'The Reticle action has no URL to verify. Set the `url` input, or run the workflow on `deployment_status`.';
export const SKIP_NOT_SUCCESS = (state) =>
  `The deployment state is "${state}", not "success". Reticle verifies only a deployment that succeeded.`;
export const PROTECTED_NO_SECRET = (status) =>
  `The preview answered ${status}: it is behind protection. For a Vercel preview, set the \`vercel-bypass-secret\` input to a Protection Bypass for Automation secret. Netlify has no bypass secret, so turn off protection for deploy previews.`;
export const PROTECTED_WRONG_SECRET = (status) =>
  `The preview answered ${status} to the \`vercel-bypass-secret\` input. Vercel did not accept the secret. Copy it again from Project Settings, Deployment Protection.`;

/** The pull request number, from the event GitHub wrote to disk, or undefined off a PR. */
export function prNumber(event) {
  const number = event?.pull_request?.number ?? event?.number;
  return Number.isInteger(number) ? number : undefined;
}

/**
 * The URL to verify. A `deployment_status` event that did not succeed is skipped, also when `url`
 * is set: the preview is not there yet. Otherwise the `url` input wins. Then the event's
 * `environment_url`, which is the preview, and then its `target_url`. Vercel and Netlify send both.
 */
export function previewUrl({ input, event }) {
  const status = event?.deployment_status;
  if (status !== undefined && status !== null && status.state !== DEPLOYMENT_SUCCESS) {
    return { skip: SKIP_NOT_SUCCESS(status.state) };
  }
  if (input.length > 0) {
    return { url: input };
  }
  const url = status?.environment_url || status?.target_url || '';
  return url.length > 0 ? { url } : { error: NO_URL };
}

/**
 * One `Set-Cookie` header as a Playwright storage-state cookie, scoped to the preview's host.
 * ponytail: every cookie is a session cookie (`Expires` and `Max-Age` are not read). The replay
 * lives shorter than the bypass cookie, so its expiry does not change a verdict.
 */
function storageCookie(header, host) {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const split = pair.indexOf('=');
  const cookie = {
    name: pair.slice(0, split),
    value: pair.slice(split + 1),
    domain: host,
    path: '/',
    expires: SESSION_COOKIE,
    httpOnly: false,
    secure: false,
    sameSite: SAME_SITE.lax,
  };
  for (const attribute of attributes) {
    const [key = '', value = ''] = attribute.split('=');
    const name = key.toLowerCase();
    if (name === 'domain') {
      cookie.domain = value;
    } else if (name === 'path') {
      cookie.path = value;
    } else if (name === 'httponly') {
      cookie.httpOnly = true;
    } else if (name === 'secure') {
      cookie.secure = true;
    } else if (name === 'samesite') {
      cookie.sameSite = SAME_SITE[value.toLowerCase()] ?? SAME_SITE.lax;
    }
  }
  return cookie;
}

/**
 * Ask the preview once, before the replay. A 401 or 403 ends the job with the secret it needs.
 * With a bypass secret, Vercel answers with a cookie that holds the bypass. That cookie goes into a
 * Playwright storage state, so every request of the replay's browser carries it, and the secret
 * itself never goes to the browser or to a third-party origin.
 */
export async function openPreview({ url, secret }) {
  const headers =
    secret.length > 0 ? { [BYPASS_HEADER]: secret, [SET_BYPASS_COOKIE_HEADER]: 'true' } : {};
  const res = await fetch(url, { headers, redirect: 'manual' });
  if (PROTECTED_STATUSES.has(res.status)) {
    return {
      error:
        secret.length > 0 ? PROTECTED_WRONG_SECRET(res.status) : PROTECTED_NO_SECRET(res.status),
    };
  }
  const setCookies = res.headers.getSetCookie();
  if (secret.length === 0 || setCookies.length === 0) {
    return {};
  }
  const host = new URL(url).hostname;
  return { storageState: { cookies: setCookies.map((h) => storageCookie(h, host)), origins: [] } };
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
  const key = env.RETICLE_API_KEY ?? '';
  const cloud = (env.RETICLE_CLOUD_URL || DEFAULT_CLOUD).replace(/\/+$/, '');
  if (key.length === 0) {
    console.error('The Reticle action needs `api-key`.');
    return 1;
  }
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const target = previewUrl({ input: env.RETICLE_ACTION_URL ?? '', event });
  if (target.skip !== undefined) {
    console.log(target.skip);
    return 0;
  }
  if (target.error !== undefined) {
    console.error(target.error);
    return 1;
  }
  const url = target.url;
  const preview = await openPreview({ url, secret: env.RETICLE_BYPASS_SECRET ?? '' });
  if (preview.error !== undefined) {
    console.error(preview.error);
    return 1;
  }
  if (!hasFlows()) {
    await pullSuite(cloud, key, env.RETICLE_PROJECT ?? '');
  }

  const temp = env.RUNNER_TEMP ?? '.';
  const resultsPath = join(temp, RESULTS_FILE);
  const storageArgs = [];
  if (preview.storageState !== undefined) {
    const statePath = join(temp, STORAGE_STATE_FILE);
    writeFileSync(statePath, JSON.stringify(preview.storageState));
    storageArgs.push('--storage-state', statePath);
  }
  const [cmd, ...pre] = env.RETICLE_BIN ? [env.RETICLE_BIN] : DEFAULT_BIN;
  spawnSync(cmd, [...pre, 'verify', url, '--results-json', resultsPath, ...storageArgs], {
    stdio: 'inherit',
    env,
  });
  const results = existsSync(resultsPath) ? readResults(readFileSync(resultsPath, 'utf8')) : [];

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
