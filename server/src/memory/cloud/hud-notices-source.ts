/**
 * The HUD rail's notices, as the daemon keeps them.
 *
 * Read synchronously (the snapshot is rebuilt many times a session), served from a disk cache that
 * survives restarts, and revalidated in the background with the stored ETag, so an unchanged file
 * costs a 304 and no body. A failed or garbled refresh keeps the last good copy: the rail is
 * marketing, and nothing about it may block or break a session. See core `hud-notices.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReticleEnv } from '@reticlehq/core';
import {
  HUD_NOTICES_URL,
  NOTICES_FILE_VERSION,
  parseHudNotices,
  type HudNoticeEntry,
} from '@reticlehq/core/hud';

/** How long a copy is trusted before it is revalidated. Notices change over days, not minutes. */
const FRESH_MS = 6 * 60 * 60 * 1_000;
const TIMEOUT_MS = 5_000;
/**
 * The largest body the daemon will read or keep. The real file is a few hundred bytes; anything near
 * this is not a notices file, and the cache on disk must not grow with whatever the network sends.
 */
export const MAX_NOTICES_BODY_BYTES = 64 * 1_024;
/** Overrides the notices URL: self-hosting, staging, tests. */
const NOTICES_URL_ENV = 'RETICLE_HUD_NOTICES_URL';

/**
 * The same opt-outs telemetry honours. The notices file carries nothing about anybody, but it is a
 * request to reticle.sh, and somebody who switched Reticle's outbound calls off asked for none.
 */
function outboundOff(env: NodeJS.ProcessEnv): boolean {
  const telemetry = (env[ReticleEnv.TELEMETRY] ?? '').toLowerCase();
  const dnt = env[ReticleEnv.DO_NOT_TRACK];
  return (
    ['0', 'false', 'off'].includes(telemetry) ||
    ('string' === typeof dnt && dnt !== '' && dnt !== '0')
  );
}

export type NoticesLoad = (
  url: string,
  etag: string | undefined,
) => Promise<{ status: number; etag?: string | undefined; body?: string | undefined }>;

interface Cached {
  etag?: string | undefined;
  fetchedAt: number;
  file: unknown;
}

export interface NoticesSource {
  /** The entries this daemon knows, unfiltered. Never throws, never waits. */
  read(): HudNoticeEntry[];
}

const defaultLoad: NoticesLoad = async (url, etag) => {
  const res = await fetch(url, {
    headers: etag === undefined ? {} : { 'if-none-match': etag },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return {
    status: res.status,
    etag: res.headers.get('etag') ?? undefined,
    body: 304 === res.status ? undefined : await res.text(),
  };
};

function readCache(path: string): Cached | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if ('object' !== typeof raw || null === raw) return undefined;
    const record = raw as Record<string, unknown>;
    const fetchedAt = record['fetchedAt'];
    const etag = record['etag'];
    return {
      fetchedAt: 'number' === typeof fetchedAt ? fetchedAt : 0,
      ...('string' === typeof etag ? { etag } : {}),
      file: record['file'],
    };
  } catch {
    return undefined;
  }
}

function writeCache(path: string, cached: Cached): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cached));
  } catch {
    /* a cache that cannot be written is a fetch next time, not an error */
  }
}

export function hudNoticesSource(opts: {
  cacheFile: string;
  now?: () => number;
  load?: NoticesLoad;
  url?: string;
}): NoticesSource {
  const now = opts.now ?? ((): number => Date.now());
  const load = opts.load ?? defaultLoad;
  const url = opts.url ?? process.env[NOTICES_URL_ENV] ?? HUD_NOTICES_URL;
  let cached = readCache(opts.cacheFile);
  let entries = cached === undefined ? [] : parseHudNotices(cached.file);
  let inFlight = false;
  let askedAt: number | undefined;

  const refresh = (): void => {
    inFlight = true;
    askedAt = now();
    void load(url, cached?.etag)
      .then((answer) => {
        if (304 === answer.status && cached !== undefined) {
          cached = { ...cached, fetchedAt: now() };
          writeCache(opts.cacheFile, cached);
          return;
        }
        if (200 !== answer.status || answer.body === undefined) return;
        if (MAX_NOTICES_BODY_BYTES < Buffer.byteLength(answer.body)) return;
        let file: unknown;
        try {
          file = JSON.parse(answer.body);
        } catch {
          return;
        }
        // An unreadable file keeps the last good notices rather than emptying the rail.
        const parsed = parseHudNotices(file);
        if (0 === parsed.length && 0 < entries.length) return;
        entries = parsed;
        // The cache holds what VALIDATED, rebuilt from the schema's output, never the body itself:
        // unknown fields and rejected entries in a network answer do not reach the disk.
        cached = {
          etag: answer.etag,
          fetchedAt: now(),
          file: { version: NOTICES_FILE_VERSION, notices: parsed },
        };
        writeCache(opts.cacheFile, cached);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    read(): HudNoticeEntry[] {
      const last = Math.max(cached?.fetchedAt ?? 0, askedAt ?? Number.NEGATIVE_INFINITY);
      const stale = cached === undefined && askedAt === undefined ? true : FRESH_MS <= now() - last;
      if (!inFlight && stale && !outboundOff(process.env)) refresh();
      return entries;
    },
  };
}
