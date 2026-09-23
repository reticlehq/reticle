/**
 * Write the harness switch back to the platform.
 *
 * The panel does not keep this state — it emits an intent and this puts it where the dashboard can
 * see it, so the two surfaces cannot disagree. Only the switch is sent: somebody who chose a
 * provider in the console must not have it reset by a panel that never rendered one. The platform's
 * PUT is what guarantees that, not the verb -- it merges the fields it is given and leaves the rest,
 * which its own spec pins ("leaves the fields it was not sent alone").
 *
 * It says PUT because that is what the platform registers. It said PATCH for one release, against a
 * route that has only ever served GET and PUT, so every write 404'd. Nothing reported it: the call
 * is fire-and-forget and failure here is deliberately silent, so the switch simply sprang back on
 * the next snapshot and looked like a UI that would not stick.
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
      method: 'PUT',
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
