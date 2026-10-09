/**
 * The harness switch, cached for a HUD that reads it inline.
 *
 * `fetchPlatformConfig` already asks the platform and parses the answer; this adds the one thing the
 * impact snapshot needs and the drive path does not — a SYNCHRONOUS read. The snapshot is rebuilt
 * dozens of times a session, the answer changes about as often as somebody opens a settings page,
 * and a panel that awaited the network on every repaint would be a panel that stutters.
 *
 * Deliberately the same shape as `harnessOfferSource` next door rather than a shared abstraction:
 * two callers with the same caching problem is not yet a pattern, and the day one of them needs a
 * different staleness rule the shared version becomes the awkward one.
 *
 * Every failure answers `undefined`, which the HUD must read as "we have not heard" and render as NO
 * control — never as "off". Showing a switch that cannot be honoured is worse than showing none.
 *
 * The loader arrives as a PORT rather than an import. Reading the platform lives in
 * `features/harness`, and a cloud-memory file reaching into a feature is the reach the directory
 * guard refuses — correctly, and for the same reason it refused the tool surface reaching the other
 * way. Whoever wires the daemon owns both sides and can hand one to the other.
 */
import type { CreditKind } from '@reticlehq/core';
import { writeHarnessSwitch } from './harness-switch.js';

/** How long a cached answer is trusted. A person who just changed it expects the panel to notice. */
const FRESH_MS = 30 * 1_000;

/** Narrowed to what this file stores: the caller's own type is richer and irrelevant here. */
export interface HarnessConfigView {
  provider: string;
  harnessEnabled: boolean;
  harnessEntitled: boolean;
  /** Whether the platform holds a key for `provider`. Entitlement is not readiness — see the offer. */
  providerReady: boolean;
  credits?: { used: number; limit: number; kind?: CreditKind | undefined; endsAt?: number };
  /** The platform's coverage gate, when it sent one: the HUD prefers it to the local score. */
  gate?: { unlocked: boolean; percent?: number; reason?: string; prompt?: string };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The answer as the HUD is pushed it: the grant's end date becomes whole days left, counted on the
 * daemon's clock (the HUD has none worth trusting for this). No end date, no days. Pure.
 */
export function configForHud(
  config: HarnessConfigView,
  now: number,
): Omit<HarnessConfigView, 'credits'> & {
  credits?: { used: number; limit: number; kind?: CreditKind | undefined; daysLeft?: number };
} {
  if (config.credits === undefined) return config;
  const { endsAt, ...credits } = config.credits;
  return {
    ...config,
    credits:
      endsAt === undefined
        ? credits
        : { ...credits, daysLeft: Math.max(0, Math.ceil((endsAt - now) / DAY_MS)) },
  };
}

export interface ConfigSource {
  read(): HarnessConfigView | undefined;
}

export interface MutableConfigSource extends ConfigSource {
  applyWrite(enabled: boolean): void;
  recheck(): void;
  subscribe(listener: () => void): () => void;
  /** Re-read in the background, telling listeners only when the answer changed. */
  poll(): void;
}

export function harnessConfigSource(
  load: () => Promise<HarnessConfigView | undefined>,
  now: () => number = () => Date.now(),
): MutableConfigSource {
  let cached: HarnessConfigView | undefined;
  // `undefined` rather than 0: "never asked" is a different state from "asked at the epoch", and
  // conflating them made a source with an injected clock never take its first read.
  let fetchedAt: number | undefined;
  let inFlight = false;
  let queuedRefresh = false;
  let revision = 0;
  /** Set for a background poll, so an unchanged answer does not repaint every HUD. */
  let quiet = false;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const refresh = (): void => {
    if (inFlight) return;
    inFlight = true;
    const startedAtRevision = revision;
    void load()
      .then((cfg) => {
        // A failed read keeps the LAST good answer rather than blanking the control mid-session:
        // one dropped request is not evidence that somebody changed their mind.
        const before = JSON.stringify(cached);
        if (startedAtRevision === revision) {
          if (cfg !== undefined) cached = cfg;
          fetchedAt = now();
        }
        // A poll that learned nothing new repaints nothing; anything else is said at once.
        if (!quiet || before !== JSON.stringify(cached)) notify();
        quiet = false;
      })
      .catch(() => {
        if (startedAtRevision === revision) fetchedAt = now();
        quiet = false;
        notify();
      })
      .finally(() => {
        inFlight = false;
        if (queuedRefresh) {
          queuedRefresh = false;
          refresh();
        }
      });
  };

  // Asked at construction, not first read: the daemon pushes a snapshot the instant a session
  // attaches, and on a page nobody drives that is the only push there will ever be.
  refresh();

  return {
    read(): HarnessConfigView | undefined {
      if (fetchedAt === undefined || FRESH_MS <= now() - fetchedAt) refresh();
      return cached;
    },
    applyWrite(enabled: boolean): void {
      revision += 1;
      if (cached !== undefined) cached = { ...cached, harnessEnabled: enabled };
      fetchedAt = now();
      notify();
      if (cached === undefined) {
        if (inFlight) queuedRefresh = true;
        else refresh();
      }
    },
    recheck(): void {
      notify(); // Roll back an optimistic HUD switch immediately, even if the GET is slow.
      if (inFlight) queuedRefresh = true;
      else refresh();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    poll(): void {
      if (inFlight) return;
      quiet = true;
      refresh();
    },
  };
}

export type ConfigsByRoot = (root: string) => MutableConfigSource;

/**
 * One live config source per project root, created on first ask; `onChange` hears every update.
 *
 * The platform read arrives as `load`, so this cache never reaches for the harness feature that
 * performs it: the daemon, which owns both, joins them. It sat inline in `start` and `startDaemon`.
 */
export function harnessConfigsByRoot(
  load: (root: string) => Promise<HarnessConfigView | undefined>,
  onChange?: (root: string) => void,
): ConfigsByRoot {
  const sources = new Map<string, MutableConfigSource>();
  return (root) => {
    let source = sources.get(root);
    if (source === undefined) {
      source = harnessConfigSource(() => load(root));
      if (onChange !== undefined) {
        source.subscribe(() => onChange(root));
        // The switch can be flipped anywhere: the console, another tab, the API. A HUD that only
        // learned of it on its next tool call showed Harness ON over a drive that had stopped.
        const live = source;
        setInterval(() => live.poll(), FRESH_MS).unref();
      }
      sources.set(root, source);
    }
    return source;
  };
}

/**
 * The HUD's harness switch, written to the platform with this project's credential. Nothing is
 * awaited: an accepted write updates the cache at once, and a refused or failed one re-reads the
 * platform so the switch springs back to the truth rather than staying where the user left it.
 */
export function applyHarnessSwitch(
  configs: ConfigsByRoot,
  root: string,
  enabled: boolean,
  envFor: () => Promise<Record<string, string | undefined>>,
): void {
  void envFor()
    .then((env) => writeHarnessSwitch(env, enabled))
    .then((saved) => {
      if (saved) configs(root).applyWrite(enabled);
      else configs(root).recheck();
    })
    .catch(() => configs(root).recheck());
}
