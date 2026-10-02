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
import type { InitOutcome, OnboardingStep } from '@reticlehq/core/telemetry';
import { spanSync } from '@/trace.js';
import { reportInitOutcome } from '@/telemetry/init-telemetry.js';
import { reportOnboardingStep } from '@/telemetry/onboarding-funnel.js';
import {
  defaultPairingTokenDir,
  readOrCreatePairingTokenSync,
} from '@/portal/bridge/pairing-token.js';
import { declaredInstallSource } from '@/telemetry/install-source.js';

/** The variable Claude Code sets on every process it spawns, and the value it sets it to. */
const CLAUDE_CODE_MARKER_ENV = 'CLAUDECODE';
const CLAUDE_CODE_MARKER_VALUE = '1';

export function serverInitHost(): InitHost {
  return {
    span<T>(name: string, fields: Record<string, unknown>, fn: () => T): T {
      return spanSync(name, fields, fn);
    },
    reportOutcome(outcome: InitOutcome): void {
      reportInitOutcome(outcome);
    },
    /**
     * One funnel step, fire-and-forget.
     *
     * `void` rather than awaited on purpose: `init` is writing files, and a step report that can
     * slow a write down — or fail one — is a metric changing what the product does, which the
     * telemetry contract forbids outright.
     */
    reportStep(step: OnboardingStep): void {
      void reportOnboardingStep(step);
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
    // Claude Code marks every process it spawns. If the marker ever changes, init falls back to the
    // notice it printed before, which is the safe direction.
    insideClaudeCode(): boolean {
      return CLAUDE_CODE_MARKER_VALUE === process.env[CLAUDE_CODE_MARKER_ENV];
    },
  };
}
