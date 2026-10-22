/**
 * `reticle login` and `reticle logout` — getting a session onto this machine, and off it.
 *
 * Split from `cloud-cli` because this is a coherent story on its own: prove who you are, write the
 * token where the other verbs will find it, and finish the job by binding the repo you are standing
 * in. The rest of the CLI reads sessions; only this file creates and destroys them.
 *
 * `cmdLink` arrives as a PARAMETER rather than an import. Login ends by linking and link needs a
 * session, so the two genuinely depend on each other; passing the linker in breaks the cycle at the
 * one call site instead of merging two commands into one file to satisfy the module graph.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { CLOUD_LINK_FILE } from '@/memory/cloud/cloud-config.js';
import { RETICLE_CONFIG_BASENAME } from './ports/resolve/cli-port.js';
import {
  DevicePollSchema,
  DeviceStartSchema,
  LoginOrigin,
  openBrowser,
  withLoginOrigin,
} from './auth/device-flow.js';
import { normalizeUrl, sessionPath, SESSIONS_DIR } from './auth/cloud-session.js';
import {
  api,
  baseUrl,
  emit,
  err,
  flags,
  hint,
  home,
  readSession,
  RETICLE_DIR,
  SESSION_FILE,
} from './cloud-kit.js';

/** Run `reticle link` with these arguments. Injected; see the note at the top of this file. */
type Linker = (argv: readonly string[]) => Promise<number>;

/**
 * Email sign-in is gone: the platform answers its routes with 410 `email_sign_in_removed`. The sentence
 * starts with the platform's own, so the terminal and the sign-in page agree. `--email`, `--code`
 * and a positional address now stop with it, because the person who typed them wants no browser, and
 * a device flow that waits for an approval nobody can give is worse than a clear refusal.
 */
export const EMAIL_SIGN_IN_REMOVED =
  'Email sign-in is gone. Sign in with Google or GitHub: run `reticle connect`, which opens the browser. ' +
  'Without a browser (CI, an agent), set RETICLE_API_KEY to a key from Settings > API keys.';

/** The flags the removed email sign-in took. Any one of them gets the sentence above. */
const EMAIL_FLAGS = ['email', 'code', 'org'] as const;

const MeSchema = z.object({ email: z.string().min(1).nullable().optional() });

/** The signed-in address, asked of the cloud. Best-effort: a login never fails for want of it. */
const signedInEmail = async (url: string, token: string): Promise<string | undefined> => {
  try {
    return MeSchema.parse(await api('GET', `${url}/v1/me`, token)).email ?? undefined;
  } catch {
    return undefined;
  }
};

/** Persist a session token under ~/.reticle and print the next step. Shared by both login paths. */
const writeSession = async (
  url: string,
  token: string,
  orgName: string,
  orgId: string | undefined,
  project: string | undefined,
  link: Linker,
  email?: string,
  autoLink = true,
): Promise<void> => {
  await mkdir(join(home(), SESSIONS_DIR), { recursive: true });
  // Who signed in, so a flow saved on this machine can say which person made it (FlowFile.author).
  const who = email ?? (await signedInEmail(url, token));
  const body = `${JSON.stringify(
    {
      url: normalizeUrl(url),
      token,
      orgName,
      ...(orgId === undefined ? {} : { orgId }),
      ...(who === undefined ? {} : { email: who }),
    },
    null,
    2,
  )}\n`;
  // Both, on purpose. The per-host file is what lets another environment stay logged in; the active
  // file is what a bare command with no override resolves through, and keeping it means nothing
  // about the single-environment workflow changes.
  await writeFile(sessionPath(home(), url), body);
  await writeFile(join(home(), SESSION_FILE), body);
  emit({ loggedIn: orgName, session: join(home(), SESSION_FILE) });
  if (autoLink) await linkAfterLogin(url, project, link);
};

/**
 * Finish the job when the shell is already standing in an unlinked Reticle project.
 *
 * `login` used to end by printing "next: `reticle link`", which made getting from local-only to
 * reporting a TWO command trip whose second half nothing enforces — and the HUD's own invitation
 * names one command, so the gap was ours to close rather than the reader's to notice. Somebody who
 * ran `reticle login` inside their instrumented repo wanted their runs on the dashboard; there is no
 * second thing they could have meant.
 *
 * Deliberately narrow, because a login that writes files in a directory the user did not mean is
 * worse than an extra step:
 *   - a `.reticle.json` must already exist. That is what `init` writes and what puts a projectId in
 *     the app's BUNDLE, which is the only thing letting the daemon attribute runs to this repo. A
 *     bare `.reticle/` directory is NOT the marker: gating on it produced repos that were linked and
 *     structurally unable to report, whose runs pooled under the daemon's own root instead.
 *   - an existing `cloud.json` is left completely alone. Re-linking would re-resolve the project and
 *     is exactly how somebody re-pointing an environment loses a binding they meant to keep.
 *   - a failure is reported and swallowed. The login SUCCEEDED and its token is already on disk;
 *     turning that into a non-zero exit would make the recoverable half look like the broken one.
 */
const linkAfterLogin = async (
  url: string,
  project: string | undefined,
  link: Linker,
): Promise<void> => {
  const fs = createNodeFileSystem();
  /*
   * The marker is `.reticle.json`, NOT a `.reticle/` directory.
   *
   * `.reticle.json` is what `init` writes and what puts a projectId in the app's bundle, which is
   * the only thing that lets the daemon attribute a session's runs to this repo. A bare `.reticle/`
   * proves nothing — it is also created by artifacts and by older builds — and auto-linking on it
   * produced a repo that was LINKED to a cloud project and yet unable to report to it: runs pooled
   * into the daemon's own ledger, and `reticle sync` here answered "nothing to send" straight after
   * two verdicts had been recorded. Measured, on this very repo's bench app.
   */
  if (!(await fs.exists(join(process.cwd(), RETICLE_CONFIG_BASENAME)))) {
    hint('next: `reticle init` here first, then `reticle connect`');
    return;
  }
  /*
   * An explicit `--project` is an instruction, so it re-binds even a repo that is already linked.
   * Without a project named, an existing binding is left completely alone — re-resolving it is how
   * somebody repointing an environment loses a binding they meant to keep.
   */
  if (
    project === undefined &&
    (await fs.exists(join(process.cwd(), RETICLE_DIR, CLOUD_LINK_FILE)))
  ) {
    hint('this repo is already linked — `reticle sync` to send what it has recorded');
    return;
  }
  try {
    await link(project === undefined ? ['--url', url] : ['--url', url, '--project', project]);
  } catch {
    hint('signed in, but linking this repo failed — run `reticle connect` to retry');
  }
};

/**
 * Browser device flow — the DEFAULT `reticle login` (like `gh auth login`): fetch a device + user code,
 * open the browser to approve, then poll until the user confirms. No email to type, no code to copy back.
 */
const cmdLoginDevice = async (
  explicitUrl: string | undefined,
  project: string | undefined,
  link: Linker,
  autoLink: boolean,
  open: (url: string) => void = openBrowser,
  from: LoginOrigin = LoginOrigin.TERMINAL,
): Promise<number> => {
  const url = baseUrl(null, explicitUrl);
  const started = DeviceStartSchema.parse(
    await api('POST', `${url}/v1/auth/device/start`, null, {}),
  );
  hint(
    `Opening ${started.verificationUri} — confirm this code in the browser: ${started.userCode}`,
  );
  open(withLoginOrigin(started.verificationUriComplete, from));
  const intervalMs = Math.max(1, started.interval) * 1000;
  for (;;) {
    await sleep(intervalMs);
    const poll = DevicePollSchema.parse(
      await api('POST', `${url}/v1/auth/device/token`, null, { deviceCode: started.deviceCode }),
    );
    if ('approved' === poll.status && poll.token !== undefined && poll.org !== undefined) {
      await writeSession(
        url,
        poll.token,
        poll.org.name,
        poll.org.id,
        project,
        link,
        undefined,
        autoLink,
      );
      return 0;
    }
    if ('pending' === poll.status) {
      if (Date.now() > started.expiresAt) {
        err('device login expired — run `reticle connect` again');
        return 1;
      }
      continue;
    }
    err(
      'denied' === poll.status
        ? 'device login was denied in the browser'
        : 'device login expired — run `reticle connect` again',
    );
    return 1;
  }
};

/** `reticle login` — the browser device flow. Email sign-in is gone (see EMAIL_SIGN_IN_REMOVED). */
export const cmdLogin = async (
  argv: readonly string[],
  link: Linker,
  autoLink = true,
): Promise<number> => {
  const f = flags(argv);
  const positional = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : undefined;
  if (positional !== undefined || EMAIL_FLAGS.some((name) => f[name] !== undefined)) {
    err(EMAIL_SIGN_IN_REMOVED);
    return 2;
  }
  return cmdLoginDevice(f['url'], f['project'], link, autoLink);
};

/** `reticle logout` — forget the cached session token (per-project keys under credentials.json stay). */
/**
 * `reticle logout` — sign out of ONE host, not of everywhere.
 *
 * Which host is the same question every other verb asks: `--url`, else the environment, else the
 * active session. Signing out of staging must leave production alone — a logout that quietly
 * cleared every environment would be discovered at the worst possible moment, mid-incident, on the
 * one you did not mean.
 */
export const cmdLogout = async (argv: readonly string[] = []): Promise<number> => {
  const active = await readSession();
  const url = baseUrl(active, flags(argv)['url']);
  await rm(sessionPath(home(), url), { force: true }).catch(() => undefined);
  // The active pointer only moves if it was pointing at the host just signed out of.
  if (null !== active && normalizeUrl(active.url) === url)
    await writeFile(join(home(), SESSION_FILE), '').catch(() => undefined);
  emit({ loggedOut: true, url });
  return 0;
};

/** The daemon signs in for the panel and links nothing: its working directory is not the user's app. */
const NO_LINK: Linker = () => Promise.resolve(0);

/**
 * The panel's Sign in: the same browser approval `reticle login` opens, started by the daemon, which
 * owns `~/.reticle`. One flow at a time, and a second press while it is pending reopens its approval
 * page rather than doing nothing: somebody who closed that tab must be able to get it back.
 * `onSignedIn` runs when the approval lands so every open panel can repaint. A failure stays in the
 * daemon log: the panel copied `reticle login` as it was clicked, which is the way through.
 */
export function hudSignIn(
  onSignedIn: () => void,
  start: (open: (url: string) => void) => Promise<number> = (open) =>
    cmdLoginDevice(undefined, undefined, NO_LINK, false, open, LoginOrigin.HUD),
  opener: (url: string) => void = openBrowser,
  /**
   * Link the asking tab's project once signed in: "Save for your team" signed in and linked
   * nothing, so the panel asked for the click just made. The daemon passes `projectLinkOnly`.
   */
  link?: (root: string) => Promise<number>,
): (from?: { artifactRoot?: string | undefined }) => void {
  let running = false;
  let pending: string | undefined;
  return (from) => {
    if (running) {
      if (pending !== undefined) opener(pending);
      return;
    }
    running = true;
    const root = from?.artifactRoot;
    void start((url) => {
      pending = url;
      opener(url);
    })
      .then(async (code) => {
        if (0 !== code) return;
        if (link !== undefined && root !== undefined) await link(root).catch(() => 1);
        onSignedIn();
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
        pending = undefined;
      });
  };
}

const WorkspacesSchema = z.object({
  active: z.string().optional(),
  memberships: z.array(z.object({ orgId: z.string(), name: z.string() })).default([]),
});
const ActivatedSchema = z.object({
  token: z.string(),
  org: z.object({ id: z.string(), name: z.string() }),
});

/**
 * The workspace `connect` links in. A person in several was linked in whichever the saved sign-in
 * was for, told "Connected", and nothing moved on the dashboard they were looking at. `--workspace
 * <name|id>` switches the sign-in (and saves it); without it, a person in more than one is told which
 * one this is and how to choose. Returns non-zero when the named workspace is not theirs.
 */
export const chooseWorkspace = async (url: string, wanted: string | undefined): Promise<number> => {
  const session = await readSession();
  if (null === session) return 0;
  let listed: z.infer<typeof WorkspacesSchema>;
  try {
    listed = WorkspacesSchema.parse(await api('GET', `${url}/v1/me/workspaces`, session.token));
  } catch {
    return 0; // an older platform: nothing to choose between
  }
  const names = listed.memberships.map((m) => `"${m.name}"`).join(', ');
  if (wanted === undefined) {
    if (1 < listed.memberships.length)
      hint(
        `you belong to ${String(listed.memberships.length)} workspaces (${names}); this links in ` +
          `"${session.orgName}". Another: reticle connect --workspace <name>`,
      );
    return 0;
  }
  const lc = wanted.toLowerCase();
  const target = listed.memberships.find((m) => m.orgId === wanted || m.name.toLowerCase() === lc);
  if (target === undefined) {
    err(`you are not a member of a workspace "${wanted}": yours are ${names}`);
    return 2;
  }
  if (target.orgId === listed.active) return 0;
  const activated = ActivatedSchema.parse(
    await api(
      'POST',
      `${url}/v1/me/workspaces/${encodeURIComponent(target.orgId)}/activate`,
      session.token,
      {},
    ),
  );
  await writeSession(
    url,
    activated.token,
    activated.org.name,
    activated.org.id,
    undefined,
    () => Promise.resolve(0),
    session.email,
    false,
  );
  hint(`signed in to workspace "${activated.org.name}"`);
  return 0;
};
