/**
 * `reticle link` — binding this repo to a cloud project, and the key that binding sends with.
 *
 * Split from `cloud-cli` because it is one story with its own rules: which project a bare `link`
 * targets, when a key already on this machine may be reused and when it provably belongs to another
 * tenant, and what is written where (`<repo>/.reticle/cloud.json` and `~/.reticle/credentials.json`).
 * Every other cloud verb only reads what this writes.
 */
import { inWorkspace, repoIdentity, resolveProjectId, defaultProjectFor } from './project-name.js';
import { apiKeyFrom } from '@reticlehq/core';
import { PlatformLinkVia } from '@reticlehq/core/telemetry';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { CLOUD_LINK_FILE } from '@/memory/cloud/cloud-config.js';
import { applyCredential, findCredential } from './auth/cloud-keystore.js';
import { linkDirectoryFrom } from '@/memory/project/link-directory.js';
import { RETICLE_CONFIG_BASENAME, readProjectId } from './ports/resolve/cli-port.js';
import {
  api,
  baseUrl,
  CREDENTIALS_FILE,
  emit,
  err,
  flags,
  hint,
  home,
  readJson,
  readSession,
  readSessionFor,
  RETICLE_DIR,
} from './cloud-kit.js';

/**
 * How a key is named out loud: enough to match it against the dashboard, never enough to use.
 *
 * The same shape the web console shows, so the two name one key identically and somebody can tell
 * at a glance which row this repo is using.
 */
const KEY_HINT_CHARS = 16;
const keyHint = (key: string): string =>
  key.length <= KEY_HINT_CHARS ? key : `${key.slice(0, KEY_HINT_CHARS)}…`;

/**
 * The api key this machine already holds for a project ON THIS CLOUD, if any.
 *
 * Two shapes, matching the resolver: `{ key, url }` is what `link` writes now and is only returned
 * when the URL matches, and a bare string is the legacy shape with no URL to check. Without the URL
 * check this would happily reuse a production key for a self-hosted link, because `link` names
 * every project "default" and the two collide in one slot.
 */
const storedCredential = async (
  projectId: string,
  url: string,
  orgId: string | undefined,
): Promise<string | undefined> =>
  findCredential(await readJson(join(home(), CREDENTIALS_FILE)), projectId, url, orgId);

/**
 * What a key is good for, or undefined when the cloud will not accept it.
 *
 * Never throws: a revoked key, a rotated one and an unreachable cloud are all "cannot reuse this",
 * and the caller's answer to every one of them is the same — mint a fresh one.
 */
export const validateKey = async (
  url: string,
  key: string,
): Promise<z.infer<typeof WhoamiSchema> | undefined> => {
  try {
    return WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, key));
  } catch {
    return undefined;
  }
};

const KeySchema = z.object({ projectId: z.string(), projectName: z.string(), key: z.string() });
const WhoamiSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /**
   * Which tenant the key belongs to. Optional for the same reason `dashboardUrl` is — an older
   * cloud does not send it — and when it is missing a stored key cannot be proved to be ours, which
   * is why the reuse path below mints instead of guessing.
   */
  orgId: z.string().optional(),
  /**
   * Where this project's dashboard lives. Optional because an older cloud does not send it, and a
   * CLI that refused to link against one would break the thing it is supposed to connect.
   */
  dashboardUrl: z.string().optional(),
});

/*
 * A project was just linked: said here, heard by whoever listens. This directory does not reach
 * telemetry (telemetry already reaches it, and two directories needing each other is a knot), so
 * the link says what happened and telemetry, installed by the entry point, listens.
 */
export interface PlatformLinked {
  via: PlatformLinkVia;
  /** The project this folder was bound to before, if any: a re-run against it is not a new link. */
  priorProjectId: unknown;
  projectId: string;
  /** The workspace's platform id, when the cloud said. */
  workspaceId: string | undefined;
}

let listener: ((link: PlatformLinked) => void) | undefined;

/** Hear every link this process makes. One listener: a second replaces the first. */
export function onPlatformLinked(next: (link: PlatformLinked) => void): void {
  listener = next;
}

export function notePlatformLinked(link: PlatformLinked): void {
  try {
    listener?.(link);
  } catch {
    /* a listener never fails a link */
  }
}

/**
 * `reticle link [--project <id>]` — bind THIS repo to a cloud project. With a login token it MINTS a
 * project-scoped key (no pasting); with a pre-set RETICLE_API_KEY it resolves the key's project via
 * whoami. Writes the non-secret binding to <repo>/.reticle/cloud.json and the secret key to
 * ~/.reticle/credentials.json (keyed by projectId).
 */
export const cmdLink = async (
  argv: readonly string[],
  /** The folder to link. The CLI's own; the daemon passes the folder of the tab that asked. */
  cwd: string = process.cwd(),
  /** What started this link, for `platform_linked`. */
  via: PlatformLinkVia = PlatformLinkVia.LINK,
): Promise<number> => {
  const f = flags(argv);
  const url = baseUrl(await readSession(), f['url']);
  // Same rule as every other authed verb: the token is looked up by the host it will be sent to.
  const session = await readSessionFor(url);
  const envKey = apiKeyFrom(process.env);
  /*
   * Read the existing binding FIRST, because it decides which project a bare `link` targets.
   * Re-running `link` is ordinary — rotating a key, repointing an environment — and it must land in
   * the project this repo already reports to, or its history splits in two without saying so.
   */
  // The project's own folder, which is where a session from here writes its runs. A link made before
  // this, in the folder `link` was run from, is still read as the prior binding.
  const projectDir = linkDirectoryFrom(cwd);
  const priorLink =
    (await readJson(join(projectDir, RETICLE_DIR, CLOUD_LINK_FILE))) ??
    (await readJson(join(cwd, RETICLE_DIR, CLOUD_LINK_FILE)));
  const priorProjectId =
    'object' === typeof priorLink && priorLink !== null
      ? (priorLink as Record<string, unknown>)['projectId']
      : undefined;

  let projectId: string;
  let projectName: string;
  let key: string;
  /**
   * The tenant this binding belongs to, recorded so the credential can be filed and found per-org.
   * Undefined against an older cloud, where the slot stays cloud+project as it always was.
   */
  let orgId: string | undefined;
  let workspace: string | undefined; // the binding's, said when the sign-in names it
  let repo: string | undefined; // which repository and folder, so a same-named app is not shared
  /** The key this machine already had for the slot, and whether it provably belongs to another tenant. */
  let priorKey: string | undefined;
  let priorIsForeign = false;
  /*
   * Where this project's dashboard lives. Asked of the cloud rather than derived from `url`: the API
   * origin and the console origin are different hosts in every deployment that is not a laptop, so a
   * link the CLI guessed would be wrong exactly where it matters.
   */
  let dashboardUrl: string | undefined;
  /** Whether the key was already on this machine — so the report can say so instead of "minted". */
  let reusedKey = false;
  // Tracked separately from the value: an OLDER cloud answers whoami without a dashboardUrl, and
  // keying the fallback off the value would ask the same question twice every time.
  let askedWhoami = false;
  if (envKey !== undefined && envKey.length > 0) {
    const who = WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, envKey));
    projectId = who.projectId;
    projectName = who.projectName;
    dashboardUrl = who.dashboardUrl;
    orgId = who.orgId;
    askedWhoami = true;
    key = envKey;
  } else if (session !== null) {
    // --project accepts a slug id OR a display name; default when omitted. Resolve to the canonical id.
    const wanted = f['project'];
    /*
     * A repo is named after itself, not "Default".
     *
     * When every repo binds to one project called "Default", two unrelated checkouts on one account
     * merge their runs, issues and impact into a single bucket and the per-project view describes
     * nothing. It is also what lets two TENANTS collide, since a credential slot built from a
     * project id is only as distinct as the ids are.
     */
    const fallback = defaultProjectFor(
      basename(projectDir),
      'string' === typeof priorProjectId ? priorProjectId : undefined,
      readProjectId(projectDir),
    );
    workspace = session.orgName;
    repo = repoIdentity(projectDir);
    // Only a default create asks for the folder's own id; a named or already-linked one is kept.
    const localId =
      wanted === undefined && 'string' !== typeof priorProjectId
        ? readProjectId(projectDir)
        : undefined;
    const targetId = await resolveProjectId(
      url,
      session.token,
      wanted ?? fallback,
      workspace,
      repo,
      localId,
    );
    /*
     * Reuse the key this machine already holds for the project, rather than minting another.
     *
     * `link` was idempotent about the BINDING and not about the KEY: two runs against one project
     * left two live `reticle-cli` keys on the account, each valid, neither identifiable to a repo.
     * Agents retry — that is what agents do — so it accumulates silently until somebody has a key
     * list they cannot reason about and revokes the wrong one.
     *
     * Validated before trusting, because a stored key can have been revoked or rotated from the
     * dashboard and a stale credential must not strand the repo. The check is the whoami call the
     * mint path already makes for `dashboardUrl`, so the common path costs no extra round trip —
     * and a key that fails it is replaced rather than reported.
     */
    const existing = await storedCredential(targetId, url, session.orgId);
    const validated = existing === undefined ? undefined : await validateKey(url, existing);
    /*
     * A valid key is not the same as OUR key.
     *
     * `validateKey` only asks whether the cloud still accepts it, and a key belonging to another
     * organisation on the same cloud passes that question perfectly. With every project named
     * "default", the slot `<url>::default` was shared across tenants — so a brand-new workspace
     * signing in on a machine that had linked a different account reused that account's key and
     * would have pushed its runs into a stranger's dashboard. Measured, not hypothesised.
     *
     * So reuse now requires PROOF of a tenant match, and treats anything less as no match: an older
     * cloud that omits `orgId`, or a session file written before we recorded one, both fall through
     * to minting. Minting a second key is a tidiness problem; pushing to the wrong tenant is a
     * disclosure, and only one of those is worth defaulting to.
     */
    const sameTenant =
      validated !== undefined &&
      session.orgId !== undefined &&
      validated.orgId !== undefined &&
      validated.orgId === session.orgId;
    const reusable = sameTenant ? validated : undefined;
    priorKey = existing;
    // Provably somebody else's: it still works on this cloud AND whoami names a different org. A key
    // that merely FAILED validation is our own revoked one, and overwriting that is the point.
    priorIsForeign =
      validated !== undefined &&
      validated.orgId !== undefined &&
      session.orgId !== undefined &&
      validated.orgId !== session.orgId;
    if (existing !== undefined && reusable !== undefined) {
      projectId = reusable.projectId;
      projectName = reusable.projectName;
      dashboardUrl = reusable.dashboardUrl;
      orgId = reusable.orgId;
      askedWhoami = true;
      key = existing;
      reusedKey = true;
    } else {
      const minted = KeySchema.parse(
        await api('POST', `${url}/v1/keys`, session.token, {
          name: 'reticle-cli',
          projectId: targetId,
        }),
      );
      projectId = minted.projectId;
      projectName = minted.projectName;
      key = minted.key;
      // The key was minted WITH this session, so its tenant is this session's by construction.
      orgId = session.orgId;
    }
  } else {
    err('run `reticle connect` first, or set RETICLE_API_KEY to link with an existing key');
    return 2;
  }

  const reticleDir = join(projectDir, RETICLE_DIR);
  await mkdir(reticleDir, { recursive: true });
  const linkPath = join(reticleDir, CLOUD_LINK_FILE);
  const prev = await readJson(linkPath);
  const prevObj =
    'object' === typeof prev && prev !== null ? (prev as Record<string, unknown>) : {};
  // The minted-key path has not asked yet. Best-effort: a link that works is worth more than a link
  // that also has a link in it, and an older cloud simply does not send one.
  if (!askedWhoami) {
    try {
      const who = WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, key));
      dashboardUrl = who.dashboardUrl;
      // Only FILL IN a tenant we do not have. The session we minted with is the authority on which
      // org this key belongs to; letting a later lookup overwrite it is how the answer drifts.
      orgId = orgId ?? who.orgId;
    } catch {
      // Older cloud, or a transient failure. The HUD shows its list without a link.
    }
  }

  const cloudJson = {
    projectId,
    projectName,
    // Recorded so the daemon resolves the credential in the ORG slot rather than the ambiguous
    // cloud+project one, which two tenants on one cloud both answer to.
    ...(orgId === undefined ? {} : { orgId }),
    url,
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
    ...(repo === undefined ? {} : { repo }),
    // The workspace's name, so `reticle status` can say where this repo sends.
    ...(workspace === undefined ? {} : { workspace }),
    sync: prevObj['sync'] ?? { runs: true, memory: true, flows: true },
    verify: prevObj['verify'] ?? 'local',
  };
  await writeFile(linkPath, `${JSON.stringify(cloudJson, null, 2)}\n`);

  await mkdir(home(), { recursive: true });
  const credPath = join(home(), CREDENTIALS_FILE);
  const creds = (await readJson(credPath)) ?? {};
  const credObj = applyCredential(
    'object' === typeof creds && creds !== null ? (creds as Record<string, unknown>) : {},
    { projectId, url, key, orgId, priorKey, priorIsForeign },
  );
  await writeFile(credPath, `${JSON.stringify(credObj, null, 2)}\n`);

  emit({ linked: projectName, projectId, cloudJson: linkPath, credentials: credPath });
  notePlatformLinked({ via, priorProjectId, projectId, workspaceId: orgId });
  /*
   * Say what just happened, in the vocabulary of somebody who has used other tools.
   *
   * `link` mints the key and stores it for you, which is the product's whole edge — and it is
   * invisible, which is its whole cost. A real report: somebody pasted a masked placeholder key
   * into a `.env` because their mental model said "I must make a key and put it somewhere". One had
   * already been minted and filed outside the repo. They did not need another step; they needed to
   * be told the step had happened.
   *
   * The key is identified the way the dashboard identifies it — a prefix, never the secret — so
   * this can be read aloud, pasted into an issue, or left in a terminal without leaking anything.
   */
  hint(`bound this repo to project "${projectName}"${inWorkspace(workspace)}`);
  if (dashboardUrl !== undefined) hint(`dashboard: ${dashboardUrl}`);
  if (projectDir !== resolve(cwd))
    hint(`linked ${relative(cwd, projectDir)}: that is where this app's runs are written`);
  hint(
    reusedKey
      ? `reusing key ${keyHint(key)} — already stored in ${credPath}, not in your repo`
      : `minted key ${keyHint(key)} — stored in ${credPath}, not in your repo`,
  );
  hint('to change it: `reticle connect --project <other>`; to inspect: `reticle status`');
  hint(
    'linked ✓ runs auto-push on `reticle verify`; `reticle sync` sends existing local runs; `reticle status` shows state',
  );
  /*
   * A binding is not a connection.
   *
   * Without `.reticle.json` the app's bundle carries no projectId, so the daemon cannot attribute a
   * session to this repo: its runs pool into whichever root the daemon itself was started in, and
   * `sync` here reports "nothing to send" however much was actually recorded. Measured on this
   * repo's bench app — two verdicts driven, then a sync that claimed there was nothing.
   *
   * Said AFTER the success line rather than refusing: the binding really was written and really is
   * correct, and the missing half is one command away. Refusing would strand somebody who links
   * before they install, which is a legitimate order to work in.
   */
  if (!(await createNodeFileSystem().exists(join(projectDir, RETICLE_CONFIG_BASENAME)))) {
    hint(
      `no ${RETICLE_CONFIG_BASENAME} here: this app's runs reach this binding only while its dev ` +
        'server runs with the Reticle build plugin, which announces it. Run `reticle init` in the app ' +
        'to make the binding hold without it.',
    );
  }
  return 0;
};
