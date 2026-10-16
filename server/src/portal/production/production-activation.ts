import { z } from 'zod';
import {
  HelloScope,
  PRODUCTION_ACTIVATE_PARAM,
  PRODUCTION_TICKET_PATH,
  ProductionTicketResponseSchema,
  type ProductionTicketRequest,
  type ProductionTicketResponse,
} from '@reticlehq/core';
import type { ProductionDrive, ProductionGrant } from './production-drive.js';

/**
 * Turn `reticle_lease { production }` into a page that will connect on a live site, in one step.
 *
 * 1. Mint a single-use session nonce for the site's origin, bound to a production drive.
 * 2. Ask the service for an activation ticket with the linked API key:
 *    `POST /v1/production-mode/tickets { workspaceId, nonce, bridgePort, scope }`.
 * 3. Hand back `<url>?reticle_activate=<ticket>` for the lease to open.
 *
 * The service decides who may activate (an owner or admin of a workspace with production mode on)
 * and signs the ticket. No static secret leaves the machine: the page only ever sees the nonce.
 */

/** Said when the service has no ticket route: an older or self-hosted service. */
export const PRODUCTION_MODE_NOT_OFFERED =
  `the server does not offer production mode (POST ${PRODUCTION_TICKET_PATH} answered 404). ` +
  'Production mode needs a Reticle service that issues activation tickets.';

/** Said when this project has no linked cloud credentials to ask with. */
export const PRODUCTION_MODE_NOT_LINKED =
  'production mode needs a linked Reticle cloud account: run `reticle connect`, or set RETICLE_API_KEY';

/** Said when the daemon cannot mint a nonce here (no bridge in this process). */
const PRODUCTION_MODE_NO_BRIDGE =
  'production mode needs the daemon that owns the bridge: start `reticle mcp` or the daemon, then lease again';

const TICKET_TIMEOUT_MS = 10_000;

/** The `production` argument of `reticle_lease { action: "acquire" }`. */
export const ProductionLeaseArgSchema = z.object({
  workspaceId: z.string().min(1).max(128).describe('The workspace the service activates for.'),
  scope: z
    .nativeEnum(HelloScope)
    .describe('observe: read only. act: also click and type, under the production policy.'),
  intent: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'What this drive is meant to do, in words. It is the only thing that lifts a refused action: "invite a teammate" allows sending an invite.',
    ),
});

export type TicketFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The part of the nonce registry activation needs: the daemon's own, never one a page reaches. */
export interface NonceMinter {
  mint(options: { origin?: string; production?: ProductionGrant }): {
    nonce: string;
    expiresAt: number;
    production?: ProductionDrive;
  };
}

export interface ActivationInput {
  production: unknown;
  url: string;
  nonces: NonceMinter | undefined;
  bridgePort: number | undefined;
  cloud: () => Promise<{ url: string; apiKey: string } | null>;
  fetch?: TicketFetch;
}

export interface Activation {
  /** The site, carrying the ticket. */
  url: string;
  drive: ProductionDrive;
  scope: HelloScope;
  expiresAt: number;
}

export async function activateProduction(input: ActivationInput): Promise<Activation> {
  const parsed = ProductionLeaseArgSchema.safeParse(input.production);
  if (!parsed.success) {
    throw new Error(
      'reticle_lease{action:"acquire"} production needs { workspaceId, scope: "observe" | "act" }',
    );
  }
  const ask = parsed.data;
  if (input.nonces === undefined || input.bridgePort === undefined) {
    throw new Error(PRODUCTION_MODE_NO_BRIDGE);
  }
  const cloud = await input.cloud();
  if (null === cloud) throw new Error(PRODUCTION_MODE_NOT_LINKED);
  const origin = new URL(input.url).origin;
  const minted = input.nonces.mint({
    origin,
    production: {
      scope: ask.scope,
      origin,
      ...(ask.intent === undefined ? {} : { intent: ask.intent }),
    },
  });
  const drive = minted.production;
  if (drive === undefined) throw new Error(PRODUCTION_MODE_NO_BRIDGE);
  const ticket = await requestTicket(
    cloud,
    {
      workspaceId: ask.workspaceId,
      nonce: minted.nonce,
      bridgePort: input.bridgePort,
      scope: ask.scope,
    },
    input.fetch,
  );
  if (ticket.policy !== undefined) drive.setPolicy(ticket.policy);
  const target = new URL(input.url);
  target.searchParams.set(PRODUCTION_ACTIVATE_PARAM, ticket.ticket);
  return { url: target.toString(), drive, scope: ask.scope, expiresAt: minted.expiresAt };
}

async function requestTicket(
  cloud: { url: string; apiKey: string },
  request: ProductionTicketRequest,
  doFetch: TicketFetch = (url, init) => fetch(url, init),
): Promise<ProductionTicketResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TICKET_TIMEOUT_MS);
  try {
    const res = await doFetch(`${cloud.url.replace(/\/+$/, '')}${PRODUCTION_TICKET_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cloud.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (404 === res.status) throw new Error(PRODUCTION_MODE_NOT_OFFERED);
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const reason = z.object({ error: z.string() }).safeParse(body);
      throw new Error(
        `the server refused a production-mode ticket (HTTP ${String(res.status)})` +
          (reason.success ? `: ${reason.data.error}` : ''),
      );
    }
    const parsed = ProductionTicketResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('the server answered the ticket request with something that is not a ticket');
    }
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The lease as the readiness wait sees it, minus the zero-install injector. An injected SDK would
 * connect with the machine's pairing token as a development session, outside the policy; a
 * production page connects only through its own activated loader.
 */
export function leaseWithoutInjection<L extends { isLoading?: () => Promise<boolean> }>(
  lease: L,
): { isLoading?: () => Promise<boolean> } {
  return lease.isLoading === undefined ? {} : { isLoading: lease.isLoading };
}

/** `reticle_lease`'s `production` argument, described for the agent. */
export const PRODUCTION_LEASE_ARG = ProductionLeaseArgSchema.optional().describe(
  'Drive a live site in production mode: mints a single-use session nonce, asks the linked Reticle service for an activation ticket, and opens the site with it. Every act then passes the production policy (docs/production-mode.md).',
);

/** What a production lease reports back. */
export const PRODUCTION_LEASE_OUTPUT = z
  .object({ scope: z.string(), expiresAt: z.number() })
  .optional()
  .describe('Present on a production lease: its scope and when its nonce expires (epoch ms).');

/** The lease's ports activation reads. */
interface ActivationPorts {
  nonces?: NonceMinter | undefined;
  bridgePort?: number | undefined;
  linkedCloud?: ((root?: string) => Promise<{ url: string; apiKey: string } | null>) | undefined;
}

/** Activate when the lease asked for production, else nothing. */
export function activationFor(
  ports: ActivationPorts,
  asked: unknown,
  url: string,
  root: string | undefined,
): Promise<Activation | undefined> {
  if (asked === undefined) return Promise.resolve(undefined);
  return activateProduction({
    production: asked,
    url,
    nonces: ports.nonces,
    bridgePort: ports.bridgePort,
    cloud: () => ports.linkedCloud?.(root) ?? Promise.resolve(null),
  });
}

/**
 * Guard a production lease's requests with its drive, and hand the readiness wait a lease it
 * cannot inject into. A development lease passes through untouched.
 */
export async function guardedForProduction<L extends { isLoading?: () => Promise<boolean> }>(
  pool: {
    guardLease(
      id: string,
      decide: (method: string, url: string) => string | undefined,
    ): Promise<boolean>;
  },
  lease: L & { sessionId: string },
  activated: Activation | undefined,
): Promise<L | { isLoading?: () => Promise<boolean> }> {
  if (activated === undefined) return lease;
  const { drive } = activated;
  await pool.guardLease(lease.sessionId, (method, url) => drive.refuseRequest(method, url));
  return leaseWithoutInjection(lease);
}

/** The `production` field of the lease result. */
export function summary(activated: Activation | undefined): {
  production?: { scope: HelloScope; expiresAt: number };
} {
  return activated === undefined
    ? {}
    : { production: { scope: activated.scope, expiresAt: activated.expiresAt } };
}

/** Playwright's name for Chrome's Local Network Access grant (local + loopback network). */
const LOCAL_NETWORK_ACCESS = 'local-network-access';

/**
 * The permissions a lease is opened with. A production page on a public origin dials the bridge on
 * loopback, which Chromium blocks unless a person grants Local Network Access, and a leased browser
 * has no person. Granted on the lease's own origin only. Not a launch flag: a second
 * `--disable-features` replaces the list Playwright launches with instead of adding to it.
 */
export function leasePermissions(
  asked: readonly string[] | undefined,
  production: unknown,
): readonly string[] | undefined {
  if (production === undefined) return asked;
  const granted = asked ?? [];
  return granted.includes(LOCAL_NETWORK_ACCESS) ? granted : [...granted, LOCAL_NETWORK_ACCESS];
}
