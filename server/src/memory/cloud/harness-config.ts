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
/** How long a cached answer is trusted. A person who just changed it expects the panel to notice. */
const FRESH_MS = 30 * 1_000;

/** Narrowed to what this file stores: the caller's own type is richer and irrelevant here. */
export interface HarnessConfigView {
  provider: string;
  harnessEnabled: boolean;
  harnessEntitled: boolean;
}

export interface ConfigSource {
  read(): HarnessConfigView | undefined;
}

export function harnessConfigSource(
  load: () => Promise<HarnessConfigView | undefined>,
  now: () => number = () => Date.now(),
): ConfigSource {
  let cached: HarnessConfigView | undefined;
  // `undefined` rather than 0: "never asked" is a different state from "asked at the epoch", and
  // conflating them made a source with an injected clock never take its first read.
  let fetchedAt: number | undefined;
  let inFlight = false;

  const refresh = (): void => {
    if (inFlight) return;
    inFlight = true;
    void load()
      .then((cfg) => {
        // A failed read keeps the LAST good answer rather than blanking the control mid-session:
        // one dropped request is not evidence that somebody changed their mind.
        if (cfg !== undefined) cached = cfg;
        fetchedAt = now();
      })
      .catch(() => {
        fetchedAt = now();
      })
      .finally(() => {
        inFlight = false;
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
  };
}
