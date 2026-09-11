/**
 * The daemon half of `reticle init`.
 *
 * `@reticlehq/init` writes files and runs a package manager and knows nothing else — no tracer, no
 * telemetry client, no bridge state directory. Those four capabilities are declared by `InitHost`
 * and supplied here, which is the whole seam between the scaffolder and the daemon. Built in one
 * place rather than at each call site so a caller cannot half-wire it: a missing reporter is a
 * metric that is silently, permanently absent, which is the failure mode telemetry always has.
 */
import type { InitHost } from '@reticlehq/init';
import type { InitOutcome } from '@reticlehq/core/telemetry';
import { spanSync } from '../../../trace.js';
import { reportInitOutcome } from '../../../telemetry/init-telemetry.js';
import {
  defaultPairingTokenDir,
  readOrCreatePairingTokenSync,
} from '../../../connection/bridge/pairing-token.js';
import { declaredInstallSource } from '../../../telemetry/install-source.js';

export function serverInitHost(): InitHost {
  return {
    span<T>(name: string, fields: Record<string, unknown>, fn: () => T): T {
      return spanSync(name, fields, fn);
    },
    reportOutcome(outcome: InitOutcome): void {
      reportInitOutcome(outcome);
    },
    /**
     * Minted here if nothing has written it yet. `init` used to READ the file and return empty when
     * the daemon had never started; the CDN snippet inlined that empty value permanently, and
     * regenerating the token made the pasted literal stale. Same mint as the daemon
     * (`readOrCreatePairingToken`), and it honours `RETICLE_PAIRING_TOKEN_DIR`.
     */
    pairingToken(): string {
      return readOrCreatePairingTokenSync(defaultPairingTokenDir()) ?? '';
    },
    installSource(): string | undefined {
      return declaredInstallSource();
    },
  };
}
