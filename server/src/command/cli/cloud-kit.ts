/**
 * The layer every cloud verb sits on: where files live, how output is written, and how a `/v1` call
 * is made and authorised.
 *
 * Extracted because it was the reason `cloud-cli` could not be split. Each verb is small and mostly
 * independent, but all of them reach for the same dozen helpers, so any attempt to lift one command
 * out dragged the plumbing with it or duplicated it. Naming the layer makes the verbs separable —
 * `cloud-login` is the first to move — and it is a real seam rather than a file-size dodge: nothing
 * here knows what a project, a credential or a link is.
 */
import { KEY_REFUSED, refusalSaid } from '@/memory/project/sync-status.js';
import { DEFAULT_PLATFORM_URL, apiKeyFrom, cloudUrlFrom } from '@reticlehq/core';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { cloudFetch } from '@/memory/cloud/cloud-sync.js';
import {
  ACTIVE_SESSION_FILE,
  normalizeUrl,
  readSessionFrom,
  resolveSessionFor,
  sessionPath,
  type Session,
} from './auth/cloud-session.js';

export const RETICLE_DIR = '.reticle';
export const SESSION_FILE = ACTIVE_SESSION_FILE;
export const CREDENTIALS_FILE = 'credentials.json';

/** The user-level reticle directory, `~/.reticle`. Sessions and credentials live here, not in a repo. */
export const home = (): string => join(homedir(), RETICLE_DIR);

export const err = (msg: string): void => {
  process.stderr.write(`reticle: ${msg}\n`);
};

/** A next-step nudge on stderr (humans read it; agents parse stdout JSON and ignore this). */
export const hint = (msg: string): void => {
  process.stderr.write(`→ ${msg}\n`);
};

export const emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
};

/** Read + parse a JSON file, or null when missing/malformed (never throws). */
export const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Parse `--flag value` pairs out of an argv tail. */
export const flags = (argv: readonly string[]): Record<string, string> => {
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a !== undefined && a.startsWith('--') && i + 1 < argv.length) {
      const v = argv[i + 1];
      if (v !== undefined) f[a.slice(2)] = v;
      i += 1;
    }
  }
  return f;
};

/** The ACTIVE session — the last host logged in to. What a bare command resolves its URL through. */
export const readSession = async (): Promise<Session | null> =>
  readSessionFrom(readJson(join(home(), SESSION_FILE)));

/**
 * The session for ONE host, or null.
 *
 * The whole safety property, holding by construction rather than by a guard somebody has to
 * remember: a token is looked up BY the host it will be sent to, so no arrangement of environment
 * variables can fetch one host's credential for a request to another. Falls back to `session.json`
 * when it names this host, so a machine that logged in before per-host sessions existed is not
 * silently signed out by an upgrade.
 */
export const readSessionFor = async (url: string): Promise<Session | null> =>
  resolveSessionFor(
    url,
    await readSessionFrom(readJson(sessionPath(home(), url))),
    await readSession(),
  );

export const baseUrl = (session: { url: string } | null, explicit?: string): string => {
  // `--url` wins over the environment: it is typed for THIS command, it is visible in shell history,
  // and it cannot leak into a sibling process the way an exported variable does.
  if (explicit !== undefined && explicit.length > 0) return normalizeUrl(explicit);
  const env = cloudUrlFrom(process.env);
  if (env !== undefined && env.length > 0) return env.replace(/\/+$/, '');
  if (null !== session && session.url.length > 0) return session.url;
  // No hint here any more. This used to warn that it was falling back to localhost, which was worth
  // saying because that default was wrong for everyone except us. The default is now the hosted
  // service, so the fallback IS the intended path — and a warning printed on the correct path is
  // how people learn to ignore stderr, which is where the real problems are written.
  return DEFAULT_PLATFORM_URL;
};

/** Bearer for a command: an explicit api key (agent) wins, else the human login token. */
export const bearer = (session: { token: string } | null): string | null =>
  apiKeyFrom(process.env) ?? session?.token ?? null;

/** The platform's code for a missing or refused credential, as opposed to a permission. */
const GENERIC_REFUSAL = 'unauthorized';

/** A credential the platform answered with: not accepted, rather than not given. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * The platform refused the credential this command sent. Its generic answer ("sign in or API key
 * required") read as if none had been set; a revoked key, or one whose owner was removed from the
 * workspace, needs replacing, not adding.
 */
export class CredentialRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly apiKey: boolean,
    /** The platform's own reason, when it named one (`refusalSaid`). */
    reason?: string,
  ) {
    super(
      apiKey
        ? `the platform refused this API key (${String(status)}): ${
            reason === undefined || KEY_REFUSED === reason
              ? 'it was revoked, or its owner no longer has access to the workspace'
              : reason.replace(/\.$/, '')
          }. Mint a new key in Settings → API keys and set RETICLE_API_KEY to it.`
        : `the platform refused your sign-in (${String(status)}): ${
            reason === undefined || KEY_REFUSED === reason
              ? 'it expired, was revoked, or you no longer have access to the workspace'
              : reason.replace(/\.$/, '')
          }. Run \`npx @reticlehq/server connect\`.`,
    );
  }
}

/** One `/v1` call. Throws a friendly Error on a non-2xx so the command surfaces it and exits 1. */
export const api = async (
  method: string,
  url: string,
  token: string | null,
  body?: unknown,
): Promise<unknown> => {
  const headers: Record<string, string> = {};
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await cloudFetch(url, init);
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`expected JSON from ${method} ${url} but got: ${text.slice(0, 120)}`);
    }
  }
  if (!res.ok) {
    const parsed = z
      .object({ error: z.object({ message: z.string(), code: z.string().optional() }) })
      .safeParse(json);
    const said = parsed.success ? parsed.data.error.message : `${res.status} ${res.statusText}`;
    // A 403 the platform explains as something else (a contributor creating a project) is a
    // permission, not a refused credential: printed as it is worded, never as "sign in again".
    const permission =
      403 === res.status &&
      parsed.success &&
      KEY_REFUSED === refusalSaid(text) &&
      GENERIC_REFUSAL !== parsed.data.error.code;
    if (token !== null && REFUSED_STATUSES.has(res.status) && !permission) {
      throw new CredentialRefusedError(
        res.status,
        token === apiKeyFrom(process.env),
        refusalSaid(text),
      );
    }
    throw new Error(said);
  }
  return json;
};
