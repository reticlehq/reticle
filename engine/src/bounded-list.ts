/**
 * A bounded list for the `detail` of a finding.
 *
 * On a page with a map, one `request-never-settled` finding listed every pending tile request. The
 * compact result got so long that the client cut it, and the verdict was hard to find (#2496). A
 * list here names at most `DETAIL_LIST_LIMIT` entries. It groups entries that share a prefix, and it
 * returns `omitted`, so the finding can say how many entries the text does not name (rule 11). It
 * also clips each name at `DETAIL_LABEL_LIMIT` characters, and returns `clipped` when it did.
 */

/** The most entries, or groups of entries, that one list in a finding's detail names. */
export const DETAIL_LIST_LIMIT = 5;

/** The most characters of one name in a list. A URL can carry a query of any length. */
export const DETAIL_LABEL_LIMIT = 200;

/**
 * One entry of a list: the text that names it, and the group it shares with similar entries.
 * `first` puts its group ahead of the others when the list is cut, so the cut never hides it.
 */
export interface ListEntry {
  label: string;
  group: string;
  first?: boolean;
}

/** The joined text, how many entries it does not name, and whether it clipped a name. */
export interface BoundedList {
  text: string;
  omitted: number;
  clipped: boolean;
}

/**
 * Join `entries` with `separator`. A list at or under the limit comes back whole, in its order. A
 * longer list is grouped: groups that hold a `first` entry come before the others, and otherwise
 * keep their order. Each of the first `limit` groups names its first entry and counts the others
 * under the group, and the groups past the limit are counted at the end.
 */
export function boundedList(
  entries: readonly ListEntry[],
  separator: string,
  limit: number = DETAIL_LIST_LIMIT,
): BoundedList {
  let clipped = false;
  const clip = (text: string): string => {
    if (text.length <= DETAIL_LABEL_LIMIT) {
      return text;
    }
    clipped = true;
    return `${text.slice(0, DETAIL_LABEL_LIMIT)}…`;
  };
  if (entries.length <= limit) {
    return { text: entries.map((e) => clip(e.label)).join(separator), omitted: 0, clipped };
  }
  const groups = new Map<string, ListEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.group);
    if (group === undefined) {
      groups.set(entry.group, [entry]);
    } else {
      group.push(entry);
    }
  }
  const leads = (group: readonly ListEntry[]): boolean => group.some((e) => true === e.first);
  const ordered = [...groups].sort(([, a], [, b]) => Number(leads(b)) - Number(leads(a)));
  const shown = ordered.slice(0, limit);
  const parts = shown.map(([name, group]) => {
    const lead = group.find((e) => true === e.first) ?? group[0];
    const first = clip(lead?.label ?? name);
    return group.length > 1
      ? `${first} and ${String(group.length - 1)} more under ${clip(name)}`
      : first;
  });
  const rest = entries.length - shown.reduce((n, [, group]) => n + group.length, 0);
  if (rest > 0) {
    parts.push(`and ${String(rest)} more`);
  }
  return { text: parts.join(separator), omitted: entries.length - shown.length, clipped };
}

/** A base for a URL that has no origin. Its origin is removed again from the prefix. */
const RELATIVE_BASE = 'http://relative.invalid';

/**
 * The origin and the first path segment of a URL, as a group key: map tiles at
 * `https://tiles.example.com/12/2048/1361.png` group under `https://tiles.example.com/12/`. A URL
 * with one path segment is its own group. Text that is not a URL comes back as it is.
 */
export function urlPrefix(url: string): string {
  if (0 === url.length) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url, RELATIVE_BASE);
  } catch {
    return url;
  }
  if ('null' === parsed.origin) {
    return url;
  }
  const origin = parsed.origin === RELATIVE_BASE ? '' : parsed.origin;
  const [, first = '', ...more] = parsed.pathname.split('/');
  return 0 === more.length ? `${origin}${parsed.pathname}` : `${origin}/${first}/`;
}
