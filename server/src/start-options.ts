/**
 * What `start()` accepts.
 *
 * A leaf: `bridge-security.ts` names this type and had to import it out of the package barrel,
 * which imports bridge-security. A shape is not a barrel's to own.
 */

import type { OwnedRealInputProvider } from './portal/input/real-input.js';
import type { InjectConnectOptions } from './portal/input/real-input.js';

export interface StartOptions {
  port?: number;
  /** Bind address. Non-loopback hosts require a token. Defaults to RETICLE_HOST or localhost. */
  host?: string;
  /** Browser/bridge pairing token. Defaults to RETICLE_TOKEN. */
  token?: string;
  /** Browser origins allowed in addition to localhost. Defaults to RETICLE_ALLOWED_ORIGINS. */
  allowedOrigins?: string[];
  /** When false, skip the MCP stdio transport (used in tests). */
  mcp?: boolean;
  /** CDP endpoint for native real-input mode. Defaults to env RETICLE_CDP_URL. No-op if unset. */
  cdpUrl?: string;
  /** launch+own a Playwright Chromium at this url and route pointer actions through it. */
  driveUrl?: string;
  /** launch headless (default true; CLI `--headed` sets false). */
  headless?: boolean;
  /** injected so tests swap in a fake launched provider instead of real Playwright. */
  realInputFactory?: (opts: { driveUrl: string; headless: boolean }) => OwnedRealInputProvider;
  /** When driving, force the page's SDK to (re)connect to our bridge with this token — verify a hosted preview. */
  injectConnect?: InjectConnectOptions;
  /** Path to a Playwright storageState JSON so the driven browser starts authenticated (past a login wall). */
  storageState?: string;
  /** absolute .reticle root. Defaults to process.cwd()/.reticle. Injectable for tests. */
  reticleRoot?: string;
  /** Directory holding the auto-provisioned pairing token. Defaults to ~/.reticle. Injectable for tests. */
  pairingTokenDir?: string;
  /** injectable clock for contract.json's generatedAt stamp. Defaults to Date.now. */
  now?: () => number;
  /**
   * Retired profile name (`core`/`full`/…). Old values still map. The live switch is
   * RETICLE_ADVERTISE_ALL_TOOLS=1; the default is the lean surface.
   */
  toolProfile?: string;
  /** Start the OEM/CI verify HTTP endpoint alongside the daemon (`reticle serve --http`). */
  httpVerify?: boolean;
  /** Port for the verify endpoint. Defaults to RETICLE_VERIFY_DEFAULT_PORT. */
  httpVerifyPort?: number;
  /** Shared token for the verify endpoint. Defaults to env RETICLE_VERIFY_TOKEN, else open (localhost). */
  httpVerifyToken?: string;
}
