import * as z from 'zod';
import { HelloScope } from './hello-mode.js';

/**
 * The production action policy: what a drive on a live site may not do unless its intent says so.
 *
 * A wire contract because two sides supply it. The engine ships `DEFAULT_PRODUCTION_POLICY`; the
 * service that issues the activation ticket may send its own list, which replaces the default for
 * that drive. The daemon enforces it where commands are dispatched, never in the page.
 */

/** Each refusal names one of these. The text follows "production policy: " in the refusal. */
export const ProductionRule = {
  PAYMENT: 'payment or checkout',
  DELETE_WORKSPACE: 'delete a workspace or project',
  REVOKE_KEY: 'revoke or rotate a key',
  SEND_INVITE: 'send an invite or email',
  CANCEL_SUBSCRIPTION: 'cancel a subscription',
  CHANGE_ROLE: "change a member's role",
  /** `scope: "observe"` reads only. */
  OBSERVE_ONLY: 'the session scope is observe, so it does not act',
  /** The drive stays on the origin it was activated for. */
  OFF_ORIGIN: 'leave the activated origin',
  /** The nonce's time is up; the drive is over. */
  EXPIRED: 'the session nonce expired',
} as const;
export type ProductionRule = (typeof ProductionRule)[keyof typeof ProductionRule];

/** The rules an intent can allow. The other three are never lifted. */
export const LIFTABLE_PRODUCTION_RULES = [
  ProductionRule.PAYMENT,
  ProductionRule.DELETE_WORKSPACE,
  ProductionRule.REVOKE_KEY,
  ProductionRule.SEND_INVITE,
  ProductionRule.CANCEL_SUBSCRIPTION,
  ProductionRule.CHANGE_ROLE,
] as const;
export type LiftableProductionRule = (typeof LIFTABLE_PRODUCTION_RULES)[number];

/** Limits on a supplied policy list, so a ticket cannot hand the daemon an unbounded regex load. */
const MAX_POLICY_ENTRIES = 64;
const MAX_POLICY_PATTERN_LENGTH = 256;

/**
 * One request the policy refuses: an HTTP method and a path pattern (a RegExp source, matched
 * case-insensitively anywhere in the URL's pathname).
 */
export const ProductionPolicyEntrySchema = z.object({
  rule: z.enum(LIFTABLE_PRODUCTION_RULES),
  methods: z.array(z.string().min(1).max(16)).min(1).max(8),
  path: z
    .string()
    .min(1)
    .max(MAX_POLICY_PATTERN_LENGTH)
    .refine((source) => {
      try {
        new RegExp(source, 'i');
        return true;
      } catch {
        return false;
      }
    }, 'not a valid regular expression'),
});
export type ProductionPolicyEntry = z.infer<typeof ProductionPolicyEntrySchema>;
export const ProductionPolicySchema = z.array(ProductionPolicyEntrySchema).max(MAX_POLICY_ENTRIES);

/** The default list: the REST shapes of the six refused actions. A service may send its own. */
export const DEFAULT_PRODUCTION_POLICY: readonly ProductionPolicyEntry[] = [
  {
    rule: ProductionRule.CANCEL_SUBSCRIPTION,
    methods: ['DELETE'],
    path: '/subscriptions?(/[^/]+)?/?$',
  },
  {
    rule: ProductionRule.CANCEL_SUBSCRIPTION,
    methods: ['POST', 'PUT', 'PATCH'],
    path: '/subscriptions?(/[^/]+)?/cancel',
  },
  {
    rule: ProductionRule.PAYMENT,
    methods: ['POST', 'PUT', 'PATCH'],
    path: '/(billing|checkout|payments?|subscriptions?|purchases?|orders?)(/|$)',
  },
  {
    rule: ProductionRule.DELETE_WORKSPACE,
    methods: ['DELETE'],
    path: '/(workspaces?|orgs?|organi[sz]ations?|projects?)/[^/]+/?$',
  },
  { rule: ProductionRule.REVOKE_KEY, methods: ['DELETE'], path: '/(api-?)?keys?/[^/]+/?$' },
  {
    rule: ProductionRule.REVOKE_KEY,
    methods: ['POST', 'PUT', 'PATCH'],
    path: '/(api-?keys?|keys?|tokens?|secrets?)(/[^/]+)?/(rotate|revoke|regenerate|roll)',
  },
  {
    rule: ProductionRule.SEND_INVITE,
    methods: ['POST', 'PUT'],
    path: '/(invites?|invitations?|emails?|mail)(/|$)',
  },
  {
    rule: ProductionRule.CHANGE_ROLE,
    methods: ['PATCH', 'PUT', 'POST'],
    path: '/members?/[^/]+(/role)?/?$',
  },
];

/** What the refusal says. Every refusal is this sentence; nothing is a silent no-op. */
export const PRODUCTION_REFUSAL_PREFIX = 'refused: production policy: ';
export const productionRefusal = (rule: ProductionRule): string =>
  `${PRODUCTION_REFUSAL_PREFIX}${rule}. ` +
  ((LIFTABLE_PRODUCTION_RULES as readonly string[]).includes(rule)
    ? 'A production drive does this only when its declared intent names it ' +
      '(reticle_lease production.intent).'
    : 'No intent allows this.');

// ── The activation ticket: daemon -> service ───────────────────────────────────────────────────

/** The service route that issues an activation ticket, authenticated with the person's API key. */
export const PRODUCTION_TICKET_PATH = '/v1/production-mode/tickets';

export const ProductionTicketRequestSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  /** The single-use HELLO token the daemon minted for this drive. */
  nonce: z.string().min(1).max(256),
  /** The daemon's bridge port. The service puts it in the page's bootstrap and its CSP. */
  bridgePort: z.number().int().min(1).max(65535),
  scope: z.nativeEnum(HelloScope),
  /**
   * The site origin the lease opens: the ticket's `origin`. Optional only so an older daemon still
   * gets a ticket; a service that is told it binds the ticket to it rather than guessing.
   */
  origin: z.string().url().max(2048).optional(),
  /**
   * The bridge the page must dial (`ws://127.0.0.1:<port>/reticle` for the daemon's own): the
   * ticket's `bridge`. Optional for the same reason; absent, the service builds it from `bridgePort`.
   */
  bridge: z.string().url().max(2048).optional(),
});
export type ProductionTicketRequest = z.infer<typeof ProductionTicketRequestSchema>;

export const ProductionTicketResponseSchema = z.object({
  /** Signed by the service (format: `activation-ticket.ts`). The lease opens `<url>?reticle_activate=<ticket>`. */
  ticket: z.string().min(1).max(4096),
  /** When the ticket must be redeemed by (ISO 8601). Informational. */
  expiresAt: z.string().max(64).optional(),
  /** The service's own refused requests for this drive. Absent: `DEFAULT_PRODUCTION_POLICY`. */
  policy: ProductionPolicySchema.optional(),
});
export type ProductionTicketResponse = z.infer<typeof ProductionTicketResponseSchema>;
