/**
 * Write the harness switch back to the platform.
 *
 * The panel does not keep this state — it emits an intent and this puts it where the dashboard can
 * see it, so the two surfaces cannot disagree. A PATCH rather than a PUT because only the switch is
 * being set: somebody who chose a provider in the console must not have it reset by a panel that
 * never rendered one.
 *
 * Failure is SILENT by design, and that deserves saying plainly rather than being discovered. A
 * dev-only overlay that threw a dialog because a settings write timed out would be worse than one
 * that quietly did not save; the next snapshot re-reads the platform, so a lost write shows up as
 * the switch springing back, which is a truthful thing for it to do.
 */
import { ReticleEnv, apiKeyFrom } from '@reticlehq/core';

const CONFIG_PATH = '/v1/model/config';

/** Same budget as the read beside it: a settings write must never hold anything up. */
const TIMEOUT_MS = 2_000;

export type SwitchFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

/** `true` when the platform accepted it. Callers use this for logging, never to block a person. */
export async function writeHarnessSwitch(
  env: Record<string, string | undefined>,
  enabled: boolean,
  doFetch: SwitchFetch = (url, init) => fetch(url, init),
  timeoutMs: number = TIMEOUT_MS,
): Promise<boolean> {
  const key = apiKeyFrom(env);
  const host = env[ReticleEnv.CLOUD_URL];
  if (key === undefined || 0 === key.length) return false;
  if (host === undefined || 0 === host.length) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    // No projectId in the body: the key IS project-scoped, and the platform refuses to let a key
    // name somebody else's project. Sending one would be asking for a privilege we do not have.
    const res = await doFetch(`${host.replace(/\/+$/, '')}${CONFIG_PATH}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ harnessEnabled: enabled }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
