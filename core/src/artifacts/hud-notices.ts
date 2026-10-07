/**
 * The notices the HUD's rail shows, edited without a release.
 *
 * The slides used to be compiled into the SDK, so changing a sentence meant shipping a version. The
 * daemon now fetches a small JSON file from our own site, keeps the entries that apply to this
 * machine, and pushes them to the HUD in the impact snapshot. The page never fetches it: the HUD runs
 * inside somebody else's app, whose Content-Security-Policy may forbid the request.
 *
 * Everything here is pure. Fetching and caching live in the daemon; the clock arrives as an argument.
 */
import { z } from 'zod';

/** Where the daemon reads the notices from. Overridable for self-hosting and tests. */
export const HUD_NOTICES_URL = 'https://reticle.sh/hud/notices.v1.json';
export const NOTICES_FILE_VERSION = 1;
/** More than this and the rail stops being a rail. */
const MAX_SHOWN = 5;

/**
 * Hosts a notice may link to. A notice is text we wrote, but the file is fetched over the network,
 * so its links are held to our own sites rather than trusted: nothing in it can send somebody
 * elsewhere, and no scheme but https can run.
 */
const LINK_HOSTS: ReadonlySet<string> = new Set([
  'reticle.sh',
  'www.reticle.sh',
  'app.reticle.sh',
  'docs.reticle.sh',
]);
const GITHUB_HOST = 'github.com';
const GITHUB_ORG_PATH = '/reticlehq/';

function isOurLink(raw: string): boolean {
  try {
    const url = new URL(raw);
    if ('https:' !== url.protocol) return false;
    if (LINK_HOSTS.has(url.hostname)) return true;
    return GITHUB_HOST === url.hostname && url.pathname.startsWith(GITHUB_ORG_PATH);
  } catch {
    return false;
  }
}

/** What the HUD renders. Only display fields: the audience rules never leave the daemon. */
export const HudNoticeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,48}$/),
  kicker: z.string().min(1).max(40).optional(),
  title: z.string().min(1).max(80),
  detail: z.string().min(1).max(120).optional(),
  cta: z.object({ label: z.string().min(1).max(24), url: z.string().refine(isOurLink) }).optional(),
});
export type HudNotice = z.infer<typeof HudNoticeSchema>;

/** `true`/`false` match that state only; absent matches anybody. */
const AudienceSchema = z.object({
  signedIn: z.boolean().optional(),
  entitled: z.boolean().optional(),
});

/** One entry in the file: a notice plus who sees it and when. */
export const HudNoticeEntrySchema = HudNoticeSchema.extend({
  audience: AudienceSchema.optional(),
  /** ISO dates. Shown from `from` (inclusive) until `until` (exclusive). */
  from: z.string().optional(),
  until: z.string().optional(),
  /** Oldest SDK that can show it, e.g. "x.y.z". */
  minSdk: z.string().optional(),
  /** Higher shows first. */
  weight: z.number().optional(),
});
export type HudNoticeEntry = z.infer<typeof HudNoticeEntrySchema>;

/**
 * The entries in a notices file this SDK understands. An unknown version or shape answers nothing,
 * and a bad entry is dropped on its own, so one typo cannot take the whole rail down.
 */
export function parseHudNotices(file: unknown): HudNoticeEntry[] {
  if ('object' !== typeof file || null === file) return [];
  const record = file as Record<string, unknown>;
  if (NOTICES_FILE_VERSION !== record['version'] || !Array.isArray(record['notices'])) return [];
  const entries: HudNoticeEntry[] = [];
  for (const raw of record['notices'] as unknown[]) {
    const parsed = HudNoticeEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/** What is known about this machine when choosing. `undefined` means "not heard yet". */
export interface NoticeContext {
  signedIn: boolean | undefined;
  entitled: boolean | undefined;
  sdkVersion: string;
  now: number;
}

function matches(want: boolean | undefined, have: boolean | undefined): boolean {
  return want === undefined || want === have;
}

/** Numeric dotted-version compare: `a >= b`. A part that is not a number counts as 0. */
function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (0 !== d) return d > 0;
  }
  return true;
}

function inWindow(entry: HudNoticeEntry, now: number): boolean {
  const from = entry.from === undefined ? Number.NaN : Date.parse(entry.from);
  const until = entry.until === undefined ? Number.NaN : Date.parse(entry.until);
  if (!Number.isNaN(from) && now < from) return false;
  if (!Number.isNaN(until) && now >= until) return false;
  return true;
}

/** The notices this machine should see now, heaviest first, display fields only. */
export function selectNotices(entries: readonly HudNoticeEntry[], ctx: NoticeContext): HudNotice[] {
  return entries
    .filter(
      (e) =>
        matches(e.audience?.signedIn, ctx.signedIn) &&
        matches(e.audience?.entitled, ctx.entitled) &&
        inWindow(e, ctx.now) &&
        (e.minSdk === undefined || versionAtLeast(ctx.sdkVersion, e.minSdk)),
    )
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, MAX_SHOWN)
    .map(({ id, kicker, title, detail, cta }) => ({
      id,
      ...(kicker === undefined ? {} : { kicker }),
      title,
      ...(detail === undefined ? {} : { detail }),
      ...(cta === undefined ? {} : { cta }),
    }));
}
