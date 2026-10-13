/**
 * Where this machine stands with the platform, for every telemetry event: signed out, signed in, or
 * this project linked to a workspace, and that workspace's id.
 *
 * Read from what the CLI already wrote, never asked of the network: the session file (through
 * `readAccountState`, which cannot carry the token) and the project's `.reticle/cloud.json`. Read per
 * event, because a sign-in from the HUD changes the answer mid-session.
 *
 * The workspace id is the platform's `orgId`: pseudonymous here, and the key the platform joins its
 * own records on. The workspace NAME and the signed-in email are never read into this.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { TelemetryAccountState } from '@reticlehq/core/telemetry';
import { readAccountState } from '@/memory/cloud/account-state.js';
import { linkDirectoryFrom } from '@/memory/project/link-directory.js';

export interface AccountEnvelope {
  accountState: TelemetryAccountState;
  linked: boolean;
  workspaceId?: string;
}

const MAX_WORKSPACE_ID = 128;

/** The link this project carries, if it is a real one (a project id and a host). */
function readLink(dir: string): { orgId?: string } | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dir, ReticleDir.ROOT, ReticleDir.CLOUD_LINK_FILE), 'utf8'),
    );
    if ('object' !== typeof raw || null === raw) return undefined;
    const o = raw as Record<string, unknown>;
    const projectId = o['projectId'];
    const url = o['url'];
    if ('string' !== typeof projectId || 0 === projectId.length) return undefined;
    if ('string' !== typeof url || 0 === url.length) return undefined;
    const orgId = o['orgId'];
    return 'string' === typeof orgId && 0 < orgId.length && orgId.length <= MAX_WORKSPACE_ID
      ? { orgId }
      : {};
  } catch {
    return undefined;
  }
}

export function accountEnvelope(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
): AccountEnvelope {
  let link: { orgId?: string } | undefined;
  try {
    link = readLink(linkDirectoryFrom(cwd)) ?? readLink(cwd);
  } catch {
    link = undefined;
  }
  if (link !== undefined) {
    return {
      accountState: TelemetryAccountState.LINKED,
      linked: true,
      ...(link.orgId === undefined ? {} : { workspaceId: link.orgId }),
    };
  }
  const signedIn = readAccountState(home, env).signedIn;
  return {
    accountState: signedIn ? TelemetryAccountState.SIGNED_IN : TelemetryAccountState.SIGNED_OUT,
    linked: false,
  };
}
