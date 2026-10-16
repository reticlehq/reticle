import { randomBytes } from 'node:crypto';
import { ProductionDrive, type ProductionGrant } from '@/portal/production/production-drive.js';

/**
 * Single-use HELLO tokens with a time limit, accepted beside the machine's pairing token.
 *
 * The pairing token is a machine-local secret, so it can never ship in a page that somebody else
 * serves. A page on a production origin gets a nonce instead: the daemon mints it for one drive,
 * the page presents it in its HELLO, and it stops working when the drive's time is up.
 *
 * Only a local caller (the MCP tools, the CLI) can mint one. Nothing on the bridge socket reaches
 * `mint`, so a page cannot give itself a token.
 */

/** How long a nonce stays valid when the caller does not say: one drive. */
export const SESSION_NONCE_TTL_MS = 60 * 60 * 1000;

/** 24 random bytes: the same entropy as the pairing token. */
const NONCE_BYTES = 24;

/** What a redeemed nonce grants the session that presented it. */
export interface NonceGrant {
  /** The page origin this nonce was minted for. The bridge admits a WebSocket from it. */
  origin?: string;
  expiresAt: number;
  /** Set when the nonce was minted for a production drive. Its session runs under the policy. */
  production?: ProductionDrive;
}

export interface MintOptions {
  origin?: string;
  ttlMs?: number;
  production?: ProductionGrant;
}

interface Entry extends NonceGrant {
  /** The session that redeemed it first. Only that session may present it again. */
  boundTo?: string;
}

export class SessionNonces {
  readonly #entries = new Map<string, Entry>();
  readonly #clock: () => number;
  readonly #random: () => string;

  constructor(deps: { clock: () => number; random?: () => string }) {
    this.#clock = deps.clock;
    this.#random = deps.random ?? (() => randomBytes(NONCE_BYTES).toString('hex'));
  }

  mint(options: MintOptions): { nonce: string; expiresAt: number; production?: ProductionDrive } {
    this.#sweep();
    const nonce = this.#random();
    const expiresAt = this.#clock() + (options.ttlMs ?? SESSION_NONCE_TTL_MS);
    // One drive per nonce, shared by every reconnect of its tab, so what it created survives a reload.
    const production =
      options.production === undefined
        ? undefined
        : new ProductionDrive({ ...options.production, expiresAt }, this.#clock);
    this.#entries.set(nonce, {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(production === undefined ? {} : { production }),
      expiresAt,
    });
    return { nonce, expiresAt, ...(production === undefined ? {} : { production }) };
  }

  /**
   * The grant for this token, or undefined when it is not a live nonce or another session holds it.
   * The first redeem binds the nonce to `sessionId`. The same tab may present it again (a reload
   * sends a new HELLO); a second tab, or a replay under another id, may not.
   */
  redeem(token: string | undefined, sessionId: string): NonceGrant | undefined {
    if (token === undefined) return undefined;
    this.#sweep();
    const entry = this.#entries.get(token);
    if (entry === undefined) return undefined;
    if (entry.boundTo !== undefined && entry.boundTo !== sessionId) return undefined;
    entry.boundTo = sessionId;
    return entry;
  }

  /** True while a live nonce was minted for this origin. */
  admitsOrigin(origin: string): boolean {
    this.#sweep();
    for (const entry of this.#entries.values()) if (entry.origin === origin) return true;
    return false;
  }

  #sweep(): void {
    const now = this.#clock();
    for (const [nonce, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(nonce);
    }
  }
}
