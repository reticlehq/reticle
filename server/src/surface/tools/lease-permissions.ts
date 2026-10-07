/**
 * The `permissions` argument of `reticle_lease { action: "acquire" }` (#1370).
 *
 * Granted before the first navigation of a fresh lease. On an origin that already has a live lease,
 * acquire hands back THAT lease rather than opening a second tab, and it may be another agent's tab
 * mid-flow — nothing at this layer knows whose it is. So its grants never change there: the same list
 * is a plain reuse, a different one is refused with the way out (release, then acquire again).
 */
import { z } from 'zod';
import { ReticleTool } from '@reticlehq/core';
import type { BrowserPool } from '@/portal/pool/browser-pool.js';
import {
  LeasePermissionError,
  NOTIFICATIONS_PERMISSION,
} from '@/portal/pool/context-permissions.js';

export const LEASE_PERMISSIONS_ARG = z
  .array(z.string().min(1))
  .optional()
  .describe(
    'Browser permissions to grant on the app origin before the first navigation, e.g. ["geolocation", "clipboard-read"]. A fresh lease starts with none granted. An origin that already has a lease keeps its grants: a different list there is refused, so release it and acquire again to change them. Names are Playwright\'s, and one it does not know is refused.',
  );

/** The family member these refusals come from, named the way `open-note.ts` names it. */
const LeaseAction = { ACQUIRE: 'acquire' } as const;
/** How this tool's refusals name the call: built from `ReticleTool.LEASE`, not spelled out. */
const ACQUIRE = `${ReticleTool.LEASE}{action:"${LeaseAction.ACQUIRE}"}`;
const INVALID_PERMISSIONS = `${ACQUIRE} permissions must be a list of permission names, e.g. ["geolocation"]`;
/** The one `Notification.permission` value that means the page can see a notifications grant. */
const GRANTED = 'granted';

type PermissionPool = Pick<BrowserPool, 'notificationPermission'>;

/** The validated list, undefined when the caller passed none, or a refusal naming the right shape. */
export function parseLeasePermissions(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const parsed = LEASE_PERMISSIONS_ARG.safeParse(raw);
  if (!parsed.success) throw new Error(INVALID_PERMISSIONS);
  return parsed.data;
}

/** A permission failure, reworded for the agent; undefined for every other error. */
export function permissionRefusal(err: unknown): Error | undefined {
  return err instanceof LeasePermissionError ? new Error(`${ACQUIRE} ${err.message}`) : undefined;
}

/**
 * What to tell the agent when the page cannot see a notifications grant, else undefined.
 *
 * Undefined too when the page could not be asked: the grant was made, and a reading nobody took is
 * not evidence that it failed.
 */
export async function notificationReadBack(
  pool: PermissionPool,
  sessionId: string,
  permissions: readonly string[] | undefined,
): Promise<string | undefined> {
  if (true !== permissions?.includes(NOTIFICATIONS_PERMISSION)) return undefined;
  const reading = await pool.notificationPermission(sessionId);
  if (reading === undefined || GRANTED === reading) return undefined;
  return (
    `notifications was granted, but this page's Notification.permission still reads "${reading}": ` +
    'the pooled headless browser does not support notifications, so UI gated on ' +
    'Notification.permission will not see the grant. navigator.permissions.query({ name: "notifications" }) does report it.'
  );
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length &&
  a.every((name) => b.includes(name)) &&
  b.every((name) => a.includes(name));

/**
 * Refuse to reuse a held lease under a different set of grants. Nothing to refuse when the caller
 * named no list, or the same one in any order.
 */
export function refuseRegrant(
  pool: Pick<BrowserPool, 'permissionsOf'>,
  sessionId: string,
  permissions: readonly string[] | undefined,
): void {
  if (permissions === undefined) return;
  const held = pool.permissionsOf(sessionId);
  if (held === undefined || sameSet(permissions, held)) return;
  throw new Error(
    `${ACQUIRE} this origin's lease ${sessionId} already holds [${held.join(', ')}], and it may be ` +
      "another agent's live tab, so its grants are not changed in place. If it is yours, release it " +
      'and acquire again with the new list.',
  );
}

/** `{ hint }` joining whichever parts are present, or nothing at all. */
export function hintOf(...parts: (string | undefined)[]): { hint?: string } {
  const present = parts.filter((part): part is string => part !== undefined);
  return 0 === present.length ? {} : { hint: present.join(' ') };
}
