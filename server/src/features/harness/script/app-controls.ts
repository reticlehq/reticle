/**
 * The app map a drive leaves for the next plan: the controls on every page the drive looked at.
 *
 * The planner reads the start page live. The crawl's clicks alone spent their budget on a
 * dashboard's navigation and never listed the Refund button on its Transactions page, so no journey
 * went near the app's costliest defects. Every lane snapshots the pages it reaches, and those
 * snapshots already hold the controls a plan needs.
 */
import { ReticleTool, asRecord, parseInteractive } from '@reticlehq/core';
import type { ToolOutcome } from '../harness.js';

/** The most controls kept: a dashboard's navigation and its pages' main buttons, not its rows. */
const MAX_APP_CONTROLS = 120;

/** A snapshot line as a page's control: `button "Refund"`, with no ref, value or state. */
const NAMED_CONTROL = /^-?\s*([a-z]+) "([^"]+)"/;

/** The page part of an address: its path and hash, without the session query a lease adds. */
function pageOf(route: string): string {
  return route.replace(/\?[^#]*/, '') || '/';
}

/** Every named control a drive saw, by page, then what the crawl clicked. */
export function appControlsOf(
  calls: readonly ToolOutcome[],
  crawled: ToolOutcome | undefined,
): { appControls?: string[] } {
  const seen: string[] = [];
  for (const call of calls) {
    if (ReticleTool.SNAPSHOT !== call.name || call.isError) continue;
    const result = asRecord(call.result);
    const tree = result['tree'];
    const route = asRecord(result['status'])['route'];
    if ('string' !== typeof tree || 'string' !== typeof route) continue;
    for (const item of parseInteractive(tree)) {
      const named = NAMED_CONTROL.exec(item.desc.trim());
      if (named !== null) seen.push(`${pageOf(route)}: ${String(named[1])} "${String(named[2])}"`);
    }
  }
  const visited = asRecord(crawled?.result)['visited'];
  if (Array.isArray(visited))
    seen.push(...visited.filter((v): v is string => 'string' === typeof v));
  const names = [...new Set(seen)];
  return 0 === names.length ? {} : { appControls: names.slice(0, MAX_APP_CONTROLS) };
}
