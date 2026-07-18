/**
 * Cloud subcommands for the `reticle` CLI — the user/agent door to Reticle Cloud, folded into the ONE
 * tool (was the standalone `reticle-cloud` bootstrap script). These are THIN clients over the `/v1` API:
 * the moat is the server, not these verbs, and OSS reticle already ships the cloud-sync client — this just
 * surfaces it. Creds live under `~/.reticle`: `session.json` (human token from `reticle login`) and
 * `credentials.json` (per-project api keys from `reticle link`). The non-secret repo binding + sync policy
 * is `<repo>/.reticle/cloud.json`. Auth for a command = `RETICLE_CLOUD_KEY` env (agent) OR the login token.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createNodeFileSystem } from './project/fs-port.js';
import { RunStore } from './runs/run-store.js';
import { resolveProjectCloud } from './cloud/cloud-config.js';
import { syncRunToCloud, SyncOutcome } from './cloud/cloud-sync.js';

const DEFAULT_URL = 'http://localhost:8890';
const RETICLE_DIR = '.reticle';
const SESSION_FILE = 'session.json';
const CREDENTIALS_FILE = 'credentials.json';
const CLOUD_LINK_FILE = 'cloud.json';
const DEFAULT_PROJECT_ID = 'default';

const CLOUD_COMMANDS: ReadonlySet<string> = new Set([
  'login',
  'logout',
  'whoami',
  'link',
  'project',
  'config',
  'push',
  'runs',
  'regression',
  'share',
]);
export const isCloudCommand = (cmd: string | undefined): boolean =>
  cmd !== undefined && CLOUD_COMMANDS.has(cmd);

const home = (): string => join(homedir(), RETICLE_DIR);
const err = (msg: string): void => {
  process.stderr.write(`reticle: ${msg}\n`);
};
/** A next-step nudge on stderr (humans read it; agents parse stdout JSON and ignore this). */
const hint = (msg: string): void => {
  process.stderr.write(`→ ${msg}\n`);
};
const emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
};

/** Read + parse a JSON file, or null when missing/malformed (never throws). */
const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Parse `--flag value` pairs out of an argv tail. */
const flags = (argv: readonly string[]): Record<string, string> => {
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

const SessionSchema = z.object({ url: z.string(), token: z.string(), orgName: z.string() });
const readSession = async (): Promise<z.infer<typeof SessionSchema> | null> => {
  const parsed = SessionSchema.safeParse(await readJson(join(home(), SESSION_FILE)));
  return parsed.success ? parsed.data : null;
};

const baseUrl = (session: { url: string } | null): string => {
  const env = process.env['RETICLE_CLOUD_URL'];
  return env !== undefined && env.length > 0 ? env.replace(/\/+$/, '') : (session?.url ?? DEFAULT_URL);
};

/** Bearer for a command: an explicit api key (agent) wins, else the human login token. */
const bearer = (session: { token: string } | null): string | null => {
  const key = process.env['RETICLE_CLOUD_KEY'];
  if (key !== undefined && key.length > 0) return key;
  return session?.token ?? null;
};

/** One `/v1` call. Throws a friendly Error on a non-2xx so the command surfaces it and exits 1. */
const api = async (
  method: string,
  url: string,
  token: string | null,
  body?: unknown,
): Promise<unknown> => {
  const headers: Record<string, string> = {};
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(json);
    throw new Error(parsed.success ? parsed.data.error.message : `${res.status} ${res.statusText}`);
  }
  return json;
};

const LoginSchema = z.object({ token: z.string(), org: z.object({ name: z.string() }) });
const KeySchema = z.object({ projectId: z.string(), projectName: z.string(), key: z.string() });
const WhoamiSchema = z.object({ projectId: z.string(), projectName: z.string() });
const CreatedProjectSchema = z.object({ projectId: z.string(), name: z.string() });
const ProjectsListSchema = z.object({
  projects: z.array(z.object({ projectId: z.string(), name: z.string() })),
});

/** Resolve a --project value that may be a slug id OR a display name into the canonical projectId. */
const resolveProjectId = async (url: string, token: string, wanted: string): Promise<string> => {
  const { projects } = ProjectsListSchema.parse(await api('GET', `${url}/v1/projects`, token));
  const lc = wanted.toLowerCase();
  const match = projects.find((p) => p.projectId === wanted || p.name.toLowerCase() === lc);
  if (match === undefined)
    throw new Error(`no project "${wanted}" — create it with \`reticle project create "${wanted}"\``);
  return match.projectId;
};

/**
 * `reticle login --email <e> [--org <name>] [--code <123456>]` — sign in, cache the token under
 * ~/.reticle.
 *
 * TWO STEPS, because the cloud proves you own the inbox before it hands out a session: ask for a code,
 * then exchange it. (It used to take an email alone — which meant anyone who knew your address owned your
 * org.) `--org` is only consulted when the account is brand new; a returning user never needs it.
 *
 * Without `--code` we request one and stop, telling the user to re-run with it. The one exception is a
 * LOCAL cloud, whose dev mailer cannot actually deliver mail and so echoes the code back in its response
 * (`devCode`) — there we complete the login in a single command rather than asking a developer to read a
 * code out of a server log they may not even be tailing.
 */
const RequestCodeSchema = z.object({ devCode: z.string().optional() });

const DeviceStartSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  interval: z.number(),
  expiresAt: z.number(),
});
const DevicePollSchema = z.object({
  status: z.string(),
  token: z.string().optional(),
  org: z.object({ name: z.string() }).optional(),
});

/** Best-effort open the approval page in the default browser; the printed URL is the headless fallback. */
const openBrowser = (target: string): void => {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* no opener available — the user opens the printed URL manually */
  }
};

/** Persist a session token under ~/.reticle and print the next step. Shared by both login paths. */
const writeSession = async (url: string, token: string, orgName: string): Promise<void> => {
  await mkdir(home(), { recursive: true });
  await writeFile(join(home(), SESSION_FILE), `${JSON.stringify({ url, token, orgName }, null, 2)}\n`);
  emit({ loggedIn: orgName, session: join(home(), SESSION_FILE) });
  hint(
    'next: `reticle link` to bind this repo to your Default project (or `reticle project create <name>` first)',
  );
};

/**
 * Browser device flow — the DEFAULT `reticle login` (like `gh auth login`): fetch a device + user code,
 * open the browser to approve, then poll until the user confirms. No email to type, no code to copy back.
 */
const cmdLoginDevice = async (): Promise<number> => {
  const url = baseUrl(null);
  const started = DeviceStartSchema.parse(await api('POST', `${url}/v1/auth/device/start`, null, {}));
  hint(`Opening ${started.verificationUri} — confirm this code in the browser: ${started.userCode}`);
  openBrowser(started.verificationUriComplete);
  const intervalMs = Math.max(1, started.interval) * 1000;
  for (;;) {
    await sleep(intervalMs);
    const poll = DevicePollSchema.parse(
      await api('POST', `${url}/v1/auth/device/token`, null, { deviceCode: started.deviceCode }),
    );
    if (poll.status === 'approved' && poll.token !== undefined && poll.org !== undefined) {
      await writeSession(url, poll.token, poll.org.name);
      return 0;
    }
    if (poll.status === 'pending') {
      if (Date.now() > started.expiresAt) {
        err('device login expired — run `reticle login` again');
        return 1;
      }
      continue;
    }
    err(
      poll.status === 'denied'
        ? 'device login was denied in the browser'
        : 'device login expired — run `reticle login` again',
    );
    return 1;
  }
};

/**
 * `reticle login` — browser device flow by default; `--email <e>` (or a positional email) keeps the
 * headless two-step code path for CI/servers where opening a browser makes no sense.
 */
const cmdLogin = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const positional = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : undefined;
  const email = f['email'] ?? positional;
  if (email === undefined) return cmdLoginDevice();
  const org = f['org'];
  const url = baseUrl(null);

  let code = f['code'];
  if (code === undefined) {
    const requested = RequestCodeSchema.parse(
      await api('POST', `${url}/v1/auth/request-code`, null, {
        email,
        ...(org !== undefined ? { orgName: org } : {}),
      }),
    );
    // A real cloud mails the code and never echoes it; a local one cannot mail, so it hands it back.
    if (requested.devCode === undefined) {
      emit({ codeSent: true, to: email });
      hint(`check your inbox, then: \`reticle login --email ${email} --code <the 6-digit code>\``);
      return 0;
    }
    code = requested.devCode;
  }

  const parsed = LoginSchema.parse(await api('POST', `${url}/v1/auth/login`, null, { email, code }));
  await writeSession(url, parsed.token, parsed.org.name);
  return 0;
};

/** `reticle logout` — forget the cached session token (per-project keys under credentials.json stay). */
const cmdLogout = async (): Promise<number> => {
  await writeFile(join(home(), SESSION_FILE), '').catch(() => undefined);
  emit({ loggedOut: true });
  return 0;
};

/**
 * `reticle whoami` — the one call an agent (or a confused human) makes to know its state: who am I logged
 * in as, and is THIS repo attached to a cloud project (and with what sync policy / verify mode)?
 */
const cmdWhoami = async (): Promise<number> => {
  const session = await readSession();
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(fs, join(process.cwd(), RETICLE_DIR), homedir(), process.env);
  emit({
    loggedInAs: session?.orgName ?? null,
    repo: {
      attached: cloud.config !== null,
      projectId: cloud.projectId,
      url: cloud.config?.url ?? null,
      sync: cloud.policy,
      verify: cloud.verify,
    },
  });
  if (cloud.config === null) hint('this repo is not attached — run `reticle link`');
  return 0;
};

/** `reticle project ls` / `reticle project create <name>` — key- or session-authed. */
const cmdProject = async (argv: readonly string[]): Promise<number> => {
  const session = await readSession();
  const token = bearer(session);
  const url = baseUrl(session);
  if (token === null) {
    err('run `reticle login` first, or set RETICLE_CLOUD_KEY');
    return 2;
  }
  const sub = argv[0];
  if (sub === 'ls') {
    emit(await api('GET', `${url}/v1/projects`, token));
    return 0;
  }
  if (sub === 'create') {
    const name = argv.slice(1).join(' ').trim();
    if (name.length === 0) {
      err('usage: reticle project create <name>');
      return 2;
    }
    const created = CreatedProjectSchema.parse(await api('POST', `${url}/v1/projects`, token, { name }));
    emit(created);
    hint(`next: \`reticle link --project ${created.projectId}\` to bind this repo`);
    return 0;
  }
  err('usage: reticle project <ls|create <name>>');
  return 2;
};

/**
 * `reticle link [--project <id>]` — bind THIS repo to a cloud project. With a login token it MINTS a
 * project-scoped key (no pasting); with a pre-set RETICLE_CLOUD_KEY it resolves the key's project via
 * whoami. Writes the non-secret binding to <repo>/.reticle/cloud.json and the secret key to
 * ~/.reticle/credentials.json (keyed by projectId).
 */
const cmdLink = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const session = await readSession();
  const url = baseUrl(session);
  const envKey = process.env['RETICLE_CLOUD_KEY'];

  let projectId: string;
  let projectName: string;
  let key: string;
  if (envKey !== undefined && envKey.length > 0) {
    const who = WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, envKey));
    projectId = who.projectId;
    projectName = who.projectName;
    key = envKey;
  } else if (session !== null) {
    // --project accepts a slug id OR a display name; default when omitted. Resolve to the canonical id.
    const wanted = f['project'];
    const targetId =
      wanted === undefined ? DEFAULT_PROJECT_ID : await resolveProjectId(url, session.token, wanted);
    const minted = KeySchema.parse(
      await api('POST', `${url}/v1/keys`, session.token, { name: 'reticle-cli', projectId: targetId }),
    );
    projectId = minted.projectId;
    projectName = minted.projectName;
    key = minted.key;
  } else {
    err('run `reticle login` first, or set RETICLE_CLOUD_KEY to link with an existing key');
    return 2;
  }

  const reticleDir = join(process.cwd(), RETICLE_DIR);
  await mkdir(reticleDir, { recursive: true });
  const linkPath = join(reticleDir, CLOUD_LINK_FILE);
  const prev = await readJson(linkPath);
  const prevObj = typeof prev === 'object' && prev !== null ? (prev as Record<string, unknown>) : {};
  const cloudJson = {
    projectId,
    projectName,
    url,
    sync: prevObj['sync'] ?? { runs: true, memory: true, flows: true },
    verify: prevObj['verify'] ?? 'local',
  };
  await writeFile(linkPath, `${JSON.stringify(cloudJson, null, 2)}\n`);

  await mkdir(home(), { recursive: true });
  const credPath = join(home(), CREDENTIALS_FILE);
  const creds = (await readJson(credPath)) ?? {};
  const credObj = typeof creds === 'object' && creds !== null ? (creds as Record<string, unknown>) : {};
  credObj[projectId] = key;
  await writeFile(credPath, `${JSON.stringify(credObj, null, 2)}\n`);

  emit({ linked: projectName, projectId, cloudJson: linkPath, credentials: credPath });
  hint('linked ✓ runs auto-push on `reticle verify`; `reticle push` sends existing local runs; `reticle whoami` shows state');
  return 0;
};

/** `reticle config [--runs on|off] [--memory on|off] [--flows on|off] [--verify local|server]`. */
const cmdConfig = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const linkPath = join(process.cwd(), RETICLE_DIR, CLOUD_LINK_FILE);
  const raw = await readJson(linkPath);
  if (raw === null || typeof raw !== 'object') {
    err('no .reticle/cloud.json here — run `reticle link` first');
    return 2;
  }
  const cfg = raw as Record<string, unknown>;
  const sync =
    typeof cfg['sync'] === 'object' && cfg['sync'] !== null
      ? (cfg['sync'] as Record<string, boolean>)
      : { runs: true, memory: true, flows: true };
  const onoff = (v: string | undefined): boolean | undefined =>
    v === 'on' ? true : v === 'off' ? false : undefined;
  for (const k of ['runs', 'memory', 'flows'] as const) {
    if (f[k] === undefined) continue;
    const b = onoff(f[k]);
    if (b === undefined) {
      err(`--${k} must be on|off`);
      return 2;
    }
    sync[k] = b;
  }
  cfg['sync'] = sync;
  if (f['verify'] !== undefined) {
    if (f['verify'] !== 'local' && f['verify'] !== 'server') {
      err('--verify must be local|server');
      return 2;
    }
    cfg['verify'] = f['verify'];
  }
  await writeFile(linkPath, `${JSON.stringify(cfg, null, 2)}\n`);
  emit({ updated: linkPath, sync: cfg['sync'], verify: cfg['verify'] });
  return 0;
};

/** `reticle push` — best-effort push of local run artifacts to the linked project (honors sync policy). */
const cmdPush = async (): Promise<number> => {
  const fs = createNodeFileSystem();
  const reticleRoot = join(process.cwd(), RETICLE_DIR);
  const cloud = await resolveProjectCloud(fs, reticleRoot, homedir(), process.env);
  if (cloud.config === null) {
    err('cloud not attached here — run `reticle link` (or set RETICLE_CLOUD_URL/KEY)');
    return 1;
  }
  if (!cloud.policy.runs) {
    emit({ pushed: 0, skipped: 'sync.runs is off for this project (reticle config --runs on)' });
    return 0;
  }
  const store = new RunStore(fs, reticleRoot);
  const ids = await store.list();
  let pushed = 0;
  let failed = 0;
  for (const id of ids) {
    const read = await store.read(id);
    if (!read.ok) continue;
    const res = await syncRunToCloud(read.run, cloud.config, (u, init) => fetch(u, init));
    if (res.outcome === SyncOutcome.SYNCED) pushed += 1;
    else if (res.outcome === SyncOutcome.FAILED) failed += 1;
  }
  emit({ pushed, failed, total: ids.length, project: cloud.projectId });
  if (pushed > 0) hint(`pushed ✓ see them in the dashboard Runs tab (${cloud.config.url})`);
  return 0;
};

/** Resolve THIS repo's linked cloud (url + project-scoped key). Throws a friendly error if not attached. */
const repoCloud = async (): Promise<{ url: string; apiKey: string }> => {
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(fs, join(process.cwd(), RETICLE_DIR), homedir(), process.env);
  if (cloud.config === null)
    throw new Error('cloud not attached here — run `reticle link` (or set RETICLE_CLOUD_URL/KEY)');
  return cloud.config;
};

/** `reticle runs` — the linked project's recent run artifacts (the key scopes it server-side). */
const cmdRuns = async (): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  emit(await api('GET', `${url}/v1/runs`, apiKey));
  return 0;
};

/** `reticle regression` — the CI gate: broken flows vs before. Exit 3 if any regressed (pipeline-friendly). */
const cmdRegression = async (): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const report = await api('GET', `${url}/v1/project/regression`, apiKey);
  emit(report);
  const parsed = z.object({ broken: z.array(z.unknown()) }).safeParse(report);
  return parsed.success && parsed.data.broken.length > 0 ? 3 : 0;
};

/** `reticle share <runId>` — mint a public proof link for one run. */
const cmdShare = async (argv: readonly string[]): Promise<number> => {
  const runId = argv[0];
  if (runId === undefined) {
    err('usage: reticle share <runId>');
    return 2;
  }
  const { url, apiKey } = await repoCloud();
  emit(await api('POST', `${url}/v1/runs/${encodeURIComponent(runId)}/share`, apiKey));
  return 0;
};

/** Dispatch a cloud subcommand. Returns the process exit code. */
export const runCloudCommand = async (argv: readonly string[]): Promise<number> => {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'login':
        return await cmdLogin(rest);
      case 'logout':
        return await cmdLogout();
      case 'whoami':
        return await cmdWhoami();
      case 'project':
        return await cmdProject(rest);
      case 'link':
        return await cmdLink(rest);
      case 'config':
        return await cmdConfig(rest);
      case 'push':
        return await cmdPush();
      case 'runs':
        return await cmdRuns();
      case 'regression':
        return await cmdRegression();
      case 'share':
        return await cmdShare(rest);
      default:
        err(`unknown cloud command '${cmd ?? ''}'`);
        return 2;
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
};
