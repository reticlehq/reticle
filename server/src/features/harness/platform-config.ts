/**
 * The driver preference a person set on the platform, read by the daemon that has to honour it.
 *
 * Choosing a model in a web UI is worth nothing if the thing doing the driving never asks. This is
 * the one call that closes that loop: the console writes a per-project preference, and the daemon
 * reads it before it builds a driver.
 *
 * Three rules shape all of it, and they are the difference between a preference and an outage:
 *
 *   - it is a PREFERENCE, not a credential. Every failure — no key, no host, a timeout, a 500, a
 *     body that does not parse — answers `undefined`, and the caller falls back to what the
 *     environment says. A drive must never fail because a settings endpoint was slow.
 *   - it is BOUNDED. The fetch is aborted rather than awaited indefinitely. A drive that hangs
 *     holds a leased browser context with nothing anywhere saying why, and "the preferences API was
 *     unreachable" is the worst possible reason for that to happen.
 *   - it never overrides someone who was EXPLICIT. A driver named in the call, or set in the
 *     environment, wins over the stored preference. Precedence lives in the caller.
 */

import { ReticleEnv, apiKeyFrom } from '@reticlehq/core';

const CONFIG_PATH = '/v1/model/config';

/**
 * How long the daemon will wait for a preference before driving without it.
 *
 * Short on purpose. This runs before a drive that takes tens of seconds, so a second of budget is
 * affordable and a stall is not — and the fallback is not a degraded mode, it is the behaviour
 * everybody had before this endpoint existed.
 */
const TIMEOUT_MS = 2_000;

/** The subset of the platform's answer the harness acts on. */
export interface PlatformModelConfig {
  /** `jev` | `anthropic` | `openai`, as the platform spells it. Not validated here. */
  provider: string;
  /** Whether the person wants autonomous driving at all. */
  harnessEnabled: boolean;
  /**
   * Whether this workspace may drive on OUR model spend — a claimed free period, or a paid plan.
   *
   * Deliberately a second boolean rather than folded into `harnessEnabled`. One is a switch a person
   * set, the other is a fact about their account, and a daemon that could not tell them apart would
   * report "you turned this off" to somebody whose free months quietly ran out.
   */
  harnessEntitled: boolean;
}

/** A GET, narrowed to what this file uses, so a test can answer it without a network. */
export type ConfigFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function parse(body: string): PlatformModelConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if ('object' !== typeof parsed || null === parsed) return undefined;
    const record = parsed as Record<string, unknown>;
    const provider = record['provider'];
    if ('string' !== typeof provider || 0 === provider.length) return undefined;
    // Absent reads as enabled: the platform's own default is on, and a daemon that treated a
    // missing field as "off" would silently disable the feature for anyone on an older API.
    const enabled = record['harnessEnabled'];
    // Same rule for both, for the same reason: an older API that reports neither must not have its
    // silence read as a refusal.
    const entitled = record['harnessEntitled'];
    return {
      provider,
      harnessEnabled: 'boolean' === typeof enabled ? enabled : true,
      harnessEntitled: 'boolean' === typeof entitled ? entitled : true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Ask the platform which model this project wants driving with.
 *
 * `undefined` means "no answer", and every caller must treat that as "carry on with the
 * environment" rather than as a failure worth reporting. There is deliberately no error channel:
 * an unreachable settings endpoint is not something the person running a drive can act on, and a
 * warning printed on a path that then works correctly is how people learn to ignore stderr.
 */
export async function fetchPlatformConfig(
  env: Record<string, string | undefined>,
  doFetch: ConfigFetch = (url, init) => fetch(url, init),
  timeoutMs: number = TIMEOUT_MS,
): Promise<PlatformModelConfig | undefined> {
  const key = apiKeyFrom(env);
  const host = env[ReticleEnv.CLOUD_URL];
  if (key === undefined || 0 === key.length) return undefined;
  if (host === undefined || 0 === host.length) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await doFetch(`${host.replace(/\/+$/, '')}${CONFIG_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    return parse(await res.text());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
