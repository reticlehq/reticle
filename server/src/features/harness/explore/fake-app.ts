/**
 * A pretend app for the exploratory Harness's tests: pages by route, each a snapshot tree, some
 * text only a scroll reaches, and what each control does when pressed. It answers the same tool
 * calls the daemon's toolset does, so the search and the survey run against it unchanged.
 */
import { ReticleTool, asRecord } from '@reticlehq/core';

export interface FakePage {
  tree: string;
  /** Text on the page that is below the fold: a scroll-to finds it, a read of the tree does not. */
  below?: readonly string[];
  /** What pressing a ref does: go to a route, or show another tree on the same route (a menu). */
  press?: Record<string, { to: string } | { opens: string }>;
}

export function fakeApp(pages: Record<string, FakePage>, start: string) {
  let route = start;
  let overlay: string | undefined;
  const calls: [string, Record<string, unknown>][] = [];
  const page = (): FakePage => pages[route] ?? { tree: '- heading "Not found"' };
  const tree = (): string => overlay ?? page().tree;
  const invoke = (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push([name, args]);
    switch (name) {
      case ReticleTool.SNAPSHOT:
        return Promise.resolve({ tree: tree(), status: { route: `${route}` } });
      case ReticleTool.NAVIGATE:
        route = String(args['url']);
        overlay = undefined;
        return Promise.resolve({ ok: true, confirmed: true });
      case ReticleTool.ACT:
      case ReticleTool.ACT_AND_WAIT: {
        const effect = page().press?.[String(args['ref'])];
        if (effect !== undefined && 'to' in effect) {
          route = effect.to;
          overlay = undefined;
        } else if (effect !== undefined) overlay = effect.opens;
        return Promise.resolve({ ok: true });
      }
      case ReticleTool.SCROLL_TO: {
        const value = String(args['value']);
        return Promise.resolve({
          found: tree().includes(value) || true === page().below?.includes(value),
        });
      }
      case ReticleTool.ASSERT: {
        const contains = String(asRecord(args['predicate'])['contains']);
        const shown = tree().includes(contains) || true === page().below?.includes(contains);
        return Promise.resolve({ verified: shown ? 'yes' : 'no' });
      }
      default:
        return Promise.resolve({ pass: true });
    }
  };
  return { invoke, calls, route: () => route };
}
