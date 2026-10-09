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

import { CreditKind, ReticleEnv, platformCredentialFrom } from '@reticlehq/core';
import type { Credits } from '@reticlehq/core/hud';

const CONFIG_PATH = '/v1/model/config';

/** The header naming the free drive a call belongs to. See `ReticleEnv.DRIVE_ID`. */
export const DRIVE_HEADER = 'x-reticle-drive';

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
  /** Whether the person switched the Harness on. Off unless the platform says on. */
  harnessEnabled: boolean;
  /**
   * Whether this workspace may drive on OUR model spend — a claimed free period, or a paid plan.
   *
   * Deliberately a second boolean rather than folded into `harnessEnabled`. One is a switch a person
   * set, the other is a fact about their account, and a daemon that could not tell them apart would
   * report "you turned this off" to somebody whose free months quietly ran out.
   */
  harnessEntitled: boolean;
  /**
   * Whether the platform actually holds a key for the provider this project is pointed at.
   *
   * Entitlement and readiness are different facts and the HUD needs both. A workspace can be fully
   * entitled -- claimed period, `harnessEnabled` on -- against a deployment that has no provider key
   * configured, and every signal then reads healthy while a drive cannot run. Absent reads as READY,
   * on the same rule as the two booleans above: an older API that does not report availability must
   * not have its silence treated as a refusal.
   */
  providerReady: boolean;
  /**
   * Harness credits used and held this 30 days, and when the grant ends (`endsAt`, epoch ms) when
   * the platform says. Absent when the plan is unbounded or the API is older.
   */
  credits?: Credits & { endsAt?: number };
  /** The platform that answered, no trailing slash: where the HUD's settings and plan links go. */
  platformUrl?: string;
  /** The platform's coverage gate (`harnessUnlocked`, `coverageScore`, `harnessLock`), when it sent one. */
  gate?: PlatformGate;
}

/** The platform's Harness coverage gate, as the HUD is pushed it. */
export interface PlatformGate {
  unlocked: boolean;
  percent?: number;
  reason?: string;
  prompt?: string;
}

/** The gate out of `/v1/model/config`, or undefined from a platform that does not send one. */
function gateOf(record: Record<string, unknown>): PlatformGate | undefined {
  const unlocked = record['harnessUnlocked'];
  if ('boolean' !== typeof unlocked) return undefined;
  const score = record['coverageScore'];
  const lock = record['harnessLock'];
  const lockRecord =
    'object' === typeof lock && null !== lock ? (lock as Record<string, unknown>) : {};
  const reason = lockRecord['reason'];
  const prompt = lockRecord['prompt'];
  return {
    unlocked,
    // Rounded down, as core's rule is: a locked app never shows 80%.
    ...('number' === typeof score ? { percent: Math.floor(score * 100 + 1e-9) } : {}),
    ...('string' === typeof reason ? { reason } : {}),
    ...('string' === typeof prompt ? { prompt } : {}),
  };
}

/** A GET, narrowed to what this file uses, so a test can answer it without a network. */
export type ConfigFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** When the grant ends, epoch ms, from an ISO date or a number. Anything else: not said. */
function endsAtOf(value: unknown): number | undefined {
  const at =
    'number' === typeof value ? value : 'string' === typeof value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

function parse(body: string): PlatformModelConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if ('object' !== typeof parsed || null === parsed) return undefined;
    const record = parsed as Record<string, unknown>;
    const provider = record['provider'];
    if ('string' !== typeof provider || 0 === provider.length) return undefined;
    // Absent reads as OFF: the Harness is opt-in, a new project starts with it off, and only the
    // platform saying it is on lets a drive spend credits.
    const enabled = record['harnessEnabled'];
    // Entitlement keeps the old rule: an older API that does not report it must not have its silence
    // read as a refusal. The switch above is what keeps an unasked drive from running.
    const entitled = record['harnessEntitled'];
    // `available` is keyed by provider and says which ones the platform holds a key for. Read only
    // the entry for the provider this project uses: another provider being configured says nothing
    // about whether THIS one can drive.
    const available = record['available'];
    const ready =
      'object' === typeof available && null !== available
        ? (available as Record<string, unknown>)[provider]
        : undefined;
    const credits = record['credits'];
    const used =
      'object' === typeof credits && null !== credits
        ? (credits as Record<string, unknown>)['used']
        : undefined;
    const limit =
      'object' === typeof credits && null !== credits
        ? (credits as Record<string, unknown>)['limit']
        : undefined;
    const kind =
      'object' === typeof credits && null !== credits
        ? Object.values(CreditKind).find((k) => k === (credits as Record<string, unknown>)['kind'])
        : undefined;
    const gate = gateOf(record);
    const endsAt = endsAtOf(
      'object' === typeof credits && null !== credits
        ? (credits as Record<string, unknown>)['endsAt']
        : undefined,
    );
    return {
      provider,
      harnessEnabled: true === enabled,
      harnessEntitled: 'boolean' === typeof entitled ? entitled : true,
      providerReady: 'boolean' === typeof ready ? ready : true,
      ...(gate === undefined ? {} : { gate }),
      ...('number' === typeof used && 'number' === typeof limit
        ? {
            credits: {
              used,
              limit,
              ...(kind === undefined ? {} : { kind }),
              ...(endsAt === undefined ? {} : { endsAt }),
            },
          }
        : {}),
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
  const cloud = platformCredentialFrom(env);
  if (cloud === undefined) return undefined;
  const key = cloud.apiKey;
  const host = cloud.url;
  const drive = env[ReticleEnv.DRIVE_ID];

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const base = host.replace(/\/+$/, '');
    const res = await doFetch(`${base}${CONFIG_PATH}`, {
      method: 'GET',
      // The free drive too: a workspace with no card is entitled for that drive and no other.
      headers: {
        authorization: `Bearer ${key}`,
        ...(drive === undefined || 0 === drive.length ? {} : { [DRIVE_HEADER]: drive }),
      },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const config = parse(await res.text());
    return config === undefined ? undefined : { ...config, platformUrl: base };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
