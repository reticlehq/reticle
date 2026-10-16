/**
 * Cloud subcommands for the `reticle` CLI — the door to the hosted service, folded into the one tool.
 * These are thin clients over the `/v1` API; the logic is server-side and these verbs just surface it.
 * Credentials live under `~/.reticle`: `session.json` (human token from `reticle login`) and
 * `credentials.json` (per-project api keys from `reticle link`). The non-secret repo binding + sync policy
 * is `<repo>/.reticle/cloud.json`. Auth for a command = `RETICLE_API_KEY` env (agent) OR the login token.
 */
import { CreatedProjectSchema } from './project-name.js';
import { keyRefusalAtLastSync } from '@/memory/project/sync-status.js';
import { apiKeyFrom } from '@reticlehq/core';
import { PlatformLinkVia } from '@reticlehq/core/telemetry';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { CLOUD_LINK_FILE, resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import {
  readMemoryPages,
  MemoryResponseScope,
  scopeMemoryResponse,
  scopeOfMemoryResponse,
} from '@/memory/cloud/memory-scope.js';
import { linkDirectoryFrom } from '@/memory/project/link-directory.js';
import { RETICLE_CONFIG_BASENAME } from './ports/resolve/cli-port.js';
import { cmdLink, validateKey } from './cloud-link.js';
// `link` moved to its own module; the CLI entry still imports it from here.
export { cmdLink } from './cloud-link.js';
import { normalizeUrl } from './auth/cloud-session.js';
import { chooseWorkspace, cmdLogin, cmdLogout } from './cloud-login.js';
import { cmdTry } from './try-command.js';
import { CLOUD_COMMANDS } from './cli-parse-grammar.js';
import {
  api,
  baseUrl,
  bearer,
  emit,
  err,
  flags,
  hint,
  readJson,
  readSession,
  readSessionFor,
  RETICLE_DIR,
} from './cloud-kit.js';
import { syncRequest } from '@/memory/cloud/cloud-sync.js';
import { GateExit, gateExitWith } from './answers/gate-exit.js';
import { brokenOf } from './known-regression.js';
import { describeUnsyncedBriefly } from '@/memory/cloud/unsynced-roots.js';
import { machineUnsyncedRoots } from '@/memory/project/sync-status.js';
import { describeSync, runSyncCycle } from '@/memory/cloud/sync-cycle.js';
import {
  diskSink,
  diskSource,
  policyScreenshots,
  readCloudIssues,
  readCloudState,
} from '@/memory/cloud/sync-disk.js';
import { fetchPlatformRun } from '@/features/harness/platform/platform-drives.js';

/**
 * Where `reticle login` dials when nothing says otherwise: the hosted service.
 *
 * This is the same origin as the dashboard — the API serves the built console — so there is one
 * host for a user to know and one for us to configure.
 *
 * It used to be `http://localhost:8890`, which is correct for exactly one audience: whoever is
 * developing the service itself. Every other user — the entire point of publishing the package —
 * typed `reticle login` and got a connection refused against a port on their own machine, which
 * reads as "the cloud is down", not "you are dialling the wrong host". Developing against a local
 * API is now what needs saying out loud, via RETICLE_CLOUD_URL, because that is the rarer case.
 */
/**
 * One session file per host, so more than one environment can be logged in at once.
 *
 * `session.json` stays what it always was — the ACTIVE login, and the thing a bare command with no
 * override resolves through. This directory is what makes staging and production hold at the same
 * time instead of clobbering each other, which is the whole reason a single file was not enough.
 */
const CLOUD_COMMAND_SET: ReadonlySet<string> = new Set(CLOUD_COMMANDS);
export const isCloudCommand = (cmd: string | undefined): boolean =>
  cmd !== undefined && CLOUD_COMMAND_SET.has(cmd);

/** `reticle sync --watch` — keep cycling instead of exiting. */
const WATCH_FLAG = '--watch';
const MOVE_HISTORY_FLAG = '--move-history';

/**
 * How often `--watch` cycles.
 *
 * A minute is chosen against what a cycle COSTS, not against how fresh anybody needs the dashboard:
 * an unchanged session sends one small GET and nothing else, so a minute is cheap enough that nobody
 * turns it off — and a sync people turn off is the only kind that actually loses data.
 */
const DEFAULT_SYNC_INTERVAL_MS = 60_000;

/**
 * The `.reticle` this folder's commands read and write: the project `link` binds (see
 * `linkDirectoryFor`), so `sync` from a monorepo root reaches the app it linked — unless only this
 * folder holds a link, made before `link` followed the project, which keeps working.
 */
const linkedRoot = (): string => {
  const project = join(linkDirectoryFrom(process.cwd()), RETICLE_DIR);
  const here = join(process.cwd(), RETICLE_DIR);
  const onlyHere =
    !existsSync(join(project, CLOUD_LINK_FILE)) && existsSync(join(here, CLOUD_LINK_FILE));
  return onlyHere ? here : project;
};

/**
 * `reticle whoami` — the one call an agent (or a confused human) makes to know its state: who am I logged
 * in as, and is THIS repo attached to a cloud project (and with what sync policy / verify mode)?
 */
const cmdWhoami = async (): Promise<number> => {
  const session = await readSession();
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(fs, linkedRoot(), homedir(), process.env);
  /*
   * The sync half of "what is my state". Without it the honest answer to "why does the dashboard
   * look old?" was to go and read a JSON file — and the two failure modes a person actually hits
   * (nothing has synced yet, and the last attempt errored) looked identical from out here.
   */
  const reticleRoot = linkedRoot();
  const state = readCloudState(reticleRoot);
  const decisions = Object.keys(readCloudIssues(reticleRoot).triage).length;
  emit({
    loggedInAs: session?.orgName ?? null,
    sync: {
      lastPushAt: state.lastPushAt ?? null,
      lastPullAt: state.lastPullAt ?? null,
      /** Present only when the machine is behind BECAUSE something failed, which is the useful case. */
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      /** Decisions collected from the dashboard and readable locally. */
      decisionsHeld: decisions,
      neverSynced: state.lastPullAt === undefined,
    },
    repo: {
      attached: cloud.config !== null,
      projectId: cloud.projectId,
      url: cloud.config?.url ?? null,
      sync: cloud.policy,
      verify: cloud.verify,
    },
  });
  // Signed out, `link` refuses with "run reticle login first"; `connect` does both in one go.
  if (null === cloud.config)
    hint(
      null === session
        ? 'this repo is not attached — run `reticle connect` (signs in and links in one step)'
        : 'this repo is not attached — run `reticle connect`',
    );
  return 0;
};

/**
 * Who is signed in and which project this repo is linked to, for `reticle status`. Local files
 * only: status must answer with no network.
 */
export const accountStatusFields = async (): Promise<{
  signedInAs: string | null;
  linkedProject: string | null;
  linkedWorkspace?: string;
  keyRefused?: string;
}> => {
  const session = await readSession();
  const cloud = await resolveProjectCloud(
    createNodeFileSystem(),
    linkedRoot(),
    homedir(),
    process.env,
  );
  // What the last sync heard, from local state, in the platform's words when it named the reason.
  const refused = keyRefusalAtLastSync(linkedRoot());
  const link = await readJson(join(linkedRoot(), CLOUD_LINK_FILE));
  const workspace =
    'object' === typeof link && null !== link
      ? (link as Record<string, unknown>)['workspace']
      : undefined;
  return {
    signedInAs: session?.orgName ?? null,
    linkedProject: null === cloud.config ? null : cloud.projectId,
    ...(null !== cloud.config && 'string' === typeof workspace && 0 < workspace.length
      ? { linkedWorkspace: workspace }
      : {}),
    ...(refused === undefined ? {} : { keyRefused: refused }),
  };
};

/** `reticle project ls` / `reticle project create <name>` — key- or session-authed. */
const cmdProject = async (argv: readonly string[]): Promise<number> => {
  const active = await readSession();
  const url = baseUrl(active);
  const session = await readSessionFor(url);
  const token = bearer(session);
  if (null === token) {
    // Name BOTH hosts when there is a session for a different one. "Run reticle login" on its own is
    // baffling to somebody who just did — the useful fact is that they logged in somewhere else.
    err(
      null !== active && normalizeUrl(active.url) !== url
        ? `signed in to ${normalizeUrl(active.url)}, but this command targets ${url} — run \`reticle connect --url ${url}\`, or set RETICLE_API_KEY`
        : `not signed in to ${url} — run \`reticle connect --url ${url}\`, or set RETICLE_API_KEY`,
    );
    return 2;
  }
  const sub = argv[0];
  if ('ls' === sub) {
    emit(await api('GET', `${url}/v1/projects`, token));
    return 0;
  }
  if ('create' === sub) {
    const name = argv.slice(1).join(' ').trim();
    if (0 === name.length) {
      err('usage: reticle project create <name>');
      return 2;
    }
    const created = CreatedProjectSchema.parse(
      await api('POST', `${url}/v1/projects`, token, { name }),
    );
    emit(created);
    hint(`next: \`reticle connect --project ${created.projectId}\` to bind this repo`);
    return 0;
  }
  if ('rename' === sub) {
    const id = argv[1];
    const name = argv.slice(2).join(' ').trim();
    if (id === undefined || 0 === name.length) {
      err('usage: reticle project rename <projectId> <new name>');
      return 2;
    }
    emit(await api('PATCH', `${url}/v1/projects/${encodeURIComponent(id)}`, token, { name }));
    return 0;
  }
  if ('rm' === sub || 'delete' === sub) {
    const id = argv[1];
    if (id === undefined) {
      err('usage: reticle project rm <projectId>');
      return 2;
    }
    emit(await api('DELETE', `${url}/v1/projects/${encodeURIComponent(id)}`, token));
    return 0;
  }
  err('usage: reticle project <ls|create <name>|rename <id> <name>|rm <id>>');
  return 2;
};

const NO_INSTALL = '--no-install';

/** Whether `reticle connect`'s init half installs the packages: not under `--no-install`. */
export const connectInstalls = (argv: readonly string[]): boolean => !argv.includes(NO_INSTALL);

/**
 * `reticle connect`: the cloud half of first-run setup in one go. A saved login is checked against
 * this host first; it links once, in the workspace chosen, then sends local history.
 */
const cmdConnect = async (given: readonly string[]): Promise<number> => {
  // `--no-install` is the init half's (see `connectInstalls`); the cloud half takes it and moves on.
  const argv = given.filter((arg) => NO_INSTALL !== arg);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      (flag !== '--project' && flag !== '--url' && flag !== '--workspace') ||
      value === undefined ||
      0 === value.length ||
      value.startsWith('--')
    ) {
      err(
        'usage: reticle connect [--project <name|id>] [--workspace <name|id>] [--url <origin>] [--no-install]',
      );
      return 2;
    }
  }
  if (!(await createNodeFileSystem().exists(join(process.cwd(), RETICLE_CONFIG_BASENAME)))) {
    err('this app is not wired yet — run `reticle init` in its directory, then `reticle connect`');
    return 2;
  }
  const f = flags(argv);
  const url = baseUrl(null, f['url']);
  if (undefined === apiKeyFrom(process.env)) {
    const session = await readSessionFor(url);
    let signedIn = false;
    if (session !== null) {
      try {
        await api('GET', `${url}/v1/me`, session.token);
        signedIn = true;
      } catch {
        hint('saved sign-in needs renewal — opening browser approval');
      }
    }
    if (!signedIn) {
      const code = await cmdLogin(['--url', url], cmdLink, false);
      if (code !== 0) return code;
    }
  }
  const chosen = await chooseWorkspace(url, f['workspace']);
  if (chosen !== 0) return chosen;
  const linkArgs = [
    '--url',
    url,
    ...(f['project'] === undefined ? [] : ['--project', f['project']]),
  ];
  const linked = await cmdLink(linkArgs, process.cwd(), PlatformLinkVia.CONNECT);
  if (linked !== 0) return linked;
  const pushed = await cmdPush();
  if (pushed !== 0) return pushed;
  hint('Connected. Open your coding agent and ask it to verify one flow in your app.');
  return 0;
};

/** `reticle config [--runs on|off] [--memory on|off] [--flows on|off] [--verify local|server]`. */
const cmdConfig = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const linkPath = join(linkedRoot(), CLOUD_LINK_FILE);
  const raw = await readJson(linkPath);
  if (null === raw || typeof raw !== 'object') {
    err('no .reticle/cloud.json here — run `reticle connect` first');
    return 2;
  }
  const cfg = raw as Record<string, unknown>;
  const sync =
    'object' === typeof cfg['sync'] && cfg['sync'] !== null
      ? (cfg['sync'] as Record<string, boolean>)
      : { runs: true, memory: true, flows: true };
  const onoff = (v: string | undefined): boolean | undefined =>
    'on' === v ? true : 'off' === v ? false : undefined;
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

/**
 * `reticle sync [--watch] [--move-history]` — one full cycle: send the difference, collect what came back.
 *
 * This replaced a `push` that re-uploaded every run artifact on every invocation. That was fine with
 * three runs and absurd with three hundred, and it only ever went one way — so a bug somebody
 * resolved on the dashboard stayed open on the laptop forever.
 *
 * The sync POLICY is applied here rather than inside the protocol: a project that has turned runs or
 * flows off simply presents a source with nothing in it, and the cycle does not need to know why.
 */
const cmdSync = async (argv: readonly string[]): Promise<number> => {
  const fs = createNodeFileSystem();
  const reticleRoot = linkedRoot();
  const cloud = await resolveProjectCloud(fs, reticleRoot, homedir(), process.env);
  if (null === cloud.config) {
    err(cloud.reason ?? 'cloud not attached here: run `reticle connect`, or set RETICLE_API_KEY');
    await reportUnsynced(fs);
    return 1;
  }
  if (cloud.note !== undefined) err(cloud.note);
  const config = cloud.config;
  const full = diskSource(reticleRoot);
  const source = {
    runs: (): ReturnType<typeof full.runs> => (cloud.policy.runs ? full.runs() : []),
    flows: (): readonly unknown[] => (cloud.policy.flows ? full.flows() : []),
    capsules: (): readonly unknown[] => (cloud.policy.capsules ? full.capsules() : []),
    // `memory` is the project's cross-run history and the derived records that summarise it.
    derived: (kind: Parameters<typeof full.derived>[0]): unknown =>
      cloud.policy.memory ? full.derived(kind) : undefined,
    ...policyScreenshots(full.screenshot, cloud.policy),
  };

  const once = async (): Promise<number> => {
    const report = await runSyncCycle({
      config,
      ...(cloud.link === undefined ? {} : { link: cloud.link }),
      // Runs made under a folder's previous link go only when the person says so.
      ...(argv.includes(MOVE_HISTORY_FLAG) ? { moveHistory: true } : {}),
      source,
      sink: diskSink(reticleRoot),
      state: readCloudState(reticleRoot),
      now: () => Date.now(),
      request: (url, init) => syncRequest(url, init),
    });
    emit({
      ok: report.ok,
      project: cloud.projectId,
      sent: {
        runs: report.runsSent,
        flows: report.flowsSent,
        records: report.derivedSent,
        ...(report.runsRejected.length > 0 ? { rejected: report.runsRejected } : {}),
        ...(report.refused.length > 0 ? { refused: report.refused } : {}),
      },
      ...(report.held.length > 0 ? { notSent: report.held } : {}),
      ...(report.notRetried.length > 0 ? { notRetried: report.notRetried } : {}),
      pulled: report.pulled,
      ...(report.morePending ? { morePending: true } : {}),
      ...(report.error === undefined ? {} : { error: report.error }),
    });
    hint(describeSync(report));
    await reportUnsynced(fs);
    return report.ok ? 0 : 1;
  };

  const watch = argv.includes(WATCH_FLAG);
  if (!watch) return once();

  const everyMs = Number(process.env['RETICLE_SYNC_INTERVAL_MS'] ?? DEFAULT_SYNC_INTERVAL_MS);
  hint(`watching ${reticleRoot} — syncing every ${String(Math.round(everyMs / 1000))}s`);
  for (;;) {
    await once();
    await sleep(everyMs);
  }
};

/**
 * Every other folder on this machine holding runs the platform never got, one line each. `sync` only
 * ever sends the folder it runs in, so a monorepo app's unlinked `.reticle` was invisible from here.
 */
const reportUnsynced = async (fs: ReturnType<typeof createNodeFileSystem>): Promise<void> => {
  for (const line of describeUnsyncedBriefly(
    await machineUnsyncedRoots(fs, homedir(), process.env),
    process.cwd(),
  ))
    hint(line);
};

/** `reticle push` — the name people already type. One cycle, same as `reticle sync`. */
const cmdPush = async (): Promise<number> => cmdSync([]);

/**
 * The linked project: its cloud, and the ID the link declares. Throws a friendly error when not
 * attached.
 *
 * The id rides along for `reticle memory`, whose entire job is "what does THIS project know" and
 * which was asking with nothing but the API key. A key covers a workspace, not a repo, so on a
 * workspace with two repos it could print a sibling's established knowledge under this project's
 * heading with no way for the reader to tell. See `memory-scope.ts`.
 *
 * The other `repoCloud()` callers below still read with the key alone. That is not an oversight
 * being papered over: this change is scoped to the memory read, and the rest each need their own
 * look at what the platform filters on.
 */
const repoCloud = async (): Promise<{
  url: string;
  apiKey: string;
  /** `null` when the link declared none — `resolveProjectCloud`'s own spelling, passed through. */
  projectId: string | null;
}> => {
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(fs, linkedRoot(), homedir(), process.env);
  if (null === cloud.config)
    throw new Error(
      cloud.reason ?? 'cloud not attached here: run `reticle connect`, or set RETICLE_API_KEY',
    );
  return { ...cloud.config, projectId: cloud.projectId };
};

/** `reticle runs` — the linked project's recent run artifacts (the key scopes it server-side). */
/**
 * `reticle runs [<id>]` — the project's runs, or one of them by id.
 *
 * With an id it is the way back to a Harness drive whose local record is gone (another machine, a
 * cleaned checkout): the platform keeps the run. A 404 is "not synced yet, or not found", never a
 * crash, since a run written a minute ago may simply not have been pushed.
 */
const cmdRuns = async (argv: readonly string[]): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const id = argv[0];
  if (id === undefined) {
    emit(await api('GET', `${url}/v1/runs`, apiKey));
    return 0;
  }
  const got = await fetchPlatformRun({ url, apiKey }, id);
  if ('error' in got) {
    err(got.error);
    return 1;
  }
  emit(got.run);
  return 0;
};

/**
 * `reticle issues [--fix <fingerprint>]` — the triage queue, where the agent can reach it.
 *
 * The dashboard is a place a PERSON looks. The defects it lists were found by an agent, are usually
 * fixed by an agent, and every one of them carries the prompt that would fix it — so requiring a
 * browser to read them puts a human copy-paste in the middle of a loop that has no other human step
 * in it.
 *
 * `--fix <fingerprint>` prints that one issue's fix prompt as BARE TEXT on stdout, nothing else: no
 * JSON envelope, no label, no trailing commentary. That is what makes it pipeable — `reticle issues
 * --fix <fp> | pbcopy`, or straight into an agent's stdin. Anything wrapped around it would have to
 * be stripped by every caller, and the ones that forgot would paste our prose into their codebase.
 */
const cmdIssues = async (argv: readonly string[]): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const fixAt = argv.indexOf('--fix');
  const wanted = -1 === fixAt ? undefined : argv[fixAt + 1];
  if (fixAt !== -1 && wanted === undefined) {
    err('usage: reticle runs issues --fix <fingerprint>');
    return 2;
  }
  const body = await api('GET', `${url}/v1/issues`, apiKey);
  if (wanted === undefined) {
    emit(body);
    return 0;
  }
  const parsed = z
    .object({
      issues: z.array(
        z.object({ fingerprint: z.string(), title: z.string(), fixPrompt: z.string().nullish() }),
      ),
    })
    .safeParse(body);
  if (!parsed.success) {
    err('the server did not return an issue list this build understands');
    return 1;
  }
  const found = parsed.data.issues.find((i) => i.fingerprint === wanted);
  if (found === undefined) {
    err(`no issue with fingerprint '${wanted}' — run \`reticle runs issues\` to list them`);
    return 2;
  }
  const prompt = found.fixPrompt;
  if (prompt === undefined || null === prompt || 0 === prompt.length) {
    // Silent on stdout, explicit on stderr: a caller piping this into an agent must get NOTHING
    // rather than an apology, or the apology becomes the prompt.
    err(`issue '${found.title}' carries no suggested fix — not every origin produces one`);
    return 4;
  }
  process.stdout.write(`${prompt}\n`);
  return 0;
};

/**
 * `reticle memory [--subject <name>]` — what this project knows, where an agent can reach it.
 *
 * Shared memory only pays for itself if something READS it. An agent about to verify checkout should
 * be able to ask what the team already knows about checkout before it starts, and it cannot open a
 * browser to find out — so the knowledge has to arrive on stdout like everything else it consumes.
 *
 * Every call is recorded server-side as a consultation. That is the number which separates memory
 * that is worth keeping from a wiki nobody opens, and it cannot be measured from the writing side.
 *
 * `--subject` narrows to one area, which is the call an agent should actually make: pulling the
 * whole corpus to answer one question is the cost the sharded store was built to avoid.
 */
const cmdMemory = async (argv: readonly string[]): Promise<number> => {
  const { url, apiKey, projectId } = await repoCloud();
  const at = argv.indexOf('--subject');
  const subject = -1 === at ? undefined : argv[at + 1];
  if (-1 !== at && subject === undefined) {
    err('usage: reticle runs memory [--subject <name>]');
    return 2;
  }
  // Scoped to the LINKED project, on the way out AND on the way back. Without the parameter
  // this printed whatever the key covered; without checking the response it still would, for as long
  // as the platform ignores a parameter it does not know yet — which is exactly the window this ships
  // in. This is the command whose whole job is "what does THIS project know", so a sibling's answer
  // arriving under this heading is the one output nobody can tell from a correct one.
  //
  // The check is on the ENVELOPE and it REFUSES rather than printing. Printing an empty list would
  // report "this project knows nothing", which is a different fact from "this response could not be
  // shown to be about this project" and the one a person is likelier to act on. Nothing goes to
  // stdout in that case: a caller piping this into an agent gets an error on stderr and a non-zero
  // exit, never a plausible-looking empty answer.
  //
  // The refusal is the PRINTER's own, not a second check here: `scopeMemoryResponse` answers
  // `undefined` for anything it cannot show to be this project's, so there is no ordering a future
  // edit can get wrong — the body it must not print is one it was never handed. The verdict is read
  // only to say WHICH refusal this is.
  const body = await readMemoryPages(url, { projectId, subject }, (page) =>
    api('GET', page, apiKey),
  );
  const printable = scopeMemoryResponse(body, projectId);
  if (printable === undefined) {
    err(
      MemoryResponseScope.OTHER === scopeOfMemoryResponse(body, projectId)
        ? `the server answered about a different project than this repo is linked to — refusing to print another project's knowledge as this one's. Check the link with \`reticle status\`.`
        : `the server's response does not say which project it is about, so there is no way to tell whether this is this project's knowledge. Refusing to print it; check the link with \`reticle status\`.`,
    );
    return 1;
  }
  emit(printable);
  return 0;
};

/** `reticle regression` — the CI gate: broken flows vs before. Exit 3 if any regressed (pipeline-friendly). */
const cmdRegression = async (): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const report = await api('GET', `${url}/v1/project/regression`, apiKey);
  emit(report);
  return gateExitWith(GateExit.PASS, brokenOf(report)?.length);
};

/** `reticle share <runId>` — mint a public proof link for one run. */
const cmdShare = async (argv: readonly string[]): Promise<number> => {
  const runId = argv[0];
  if (runId === undefined) {
    err('usage: reticle runs share <runId>');
    return 2;
  }
  const { url, apiKey } = await repoCloud();
  emit(await api('POST', `${url}/v1/runs/${encodeURIComponent(runId)}/share`, apiKey));
  return 0;
};

/** `reticle runs <regression|share|issues|memory>`, and `reticle runs [<runId>]` otherwise. */
const cmdRunsFamily = async (argv: readonly string[]): Promise<number> => {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'regression':
      return cmdRegression();
    case 'share':
      return cmdShare(rest);
    case 'issues':
      return cmdIssues(rest);
    case 'memory':
      return cmdMemory(rest);
    default:
      return cmdRuns(argv);
  }
};

/** Dispatch a cloud subcommand. Returns the process exit code. */
export const runCloudCommand = async (argv: readonly string[]): Promise<number> => {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'login':
        // The linker is passed in rather than imported by cloud-login: login ends by linking and
        // link needs a session, so the cycle is broken at this one call site.
        return await cmdLogin(rest, cmdLink);
      case 'connect':
        return await cmdConnect(rest);
      case 'try':
        return await cmdTry(rest, {
          push: () => cmdSync([]),
          dashboardUrl: async (c) => (await validateKey(c.url, c.apiKey))?.dashboardUrl,
        });
      case 'logout':
        return await cmdLogout(rest);
      case 'whoami':
        return await cmdWhoami();
      case 'project':
        return await cmdProject(rest);
      case 'link':
        return await cmdLink(rest);
      case 'config':
        return await cmdConfig(rest);
      // `push` is the name people type, so it takes `--watch` too: the help and the README say so.
      case 'push':
        return await cmdSync(rest);
      case 'sync':
        return await cmdSync(rest);
      case 'runs':
        return await cmdRunsFamily(rest);
      case 'issues':
        return await cmdIssues(rest);
      case 'memory':
        return await cmdMemory(rest);
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
