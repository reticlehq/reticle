/**
 * Enterprise-scale fixture knobs. Read from the URL so a benchmark can dial the fixture without a
 * rebuild, e.g. `?enterprise=1&enterprise-rows=5000&enterprise-depth=30`.
 *
 * Everything here is inert unless the Enterprise view is enabled: `isEnterpriseEnabled()` is false
 * for every existing benchmark URL, so the nav item is not rendered and the view never mounts.
 */

const EnterpriseParam = {
  ENABLED: 'enterprise',
  ROWS: 'enterprise-rows',
  COLS: 'enterprise-cols',
  DEPTH: 'enterprise-depth',
  POLL_HZ: 'enterprise-poll-hz',
  CHURN_MS: 'enterprise-churn-ms',
  CHURN_NODES: 'enterprise-churn-nodes',
  HOT_MS: 'enterprise-hot-ms',
} as const;

/** Defaults land on ~10k nodes / depth ~15 / 20 req-per-sec — the "real enterprise React app" shape. */
const EnterpriseDefault = {
  ROWS: 1000,
  COLS: 4,
  DEPTH: 15,
  POLL_HZ: 20,
  CHURN_MS: 1000,
  CHURN_NODES: 300,
  HOT_MS: 500,
} as const;

interface EnterpriseConfig {
  rows: number;
  cols: number;
  depth: number;
  pollHz: number;
  churnMs: number;
  churnNodes: number;
  hotMs: number;
}

const PARAM_PREFIX = 'enterprise-';

function search(): URLSearchParams {
  return new URLSearchParams('undefined' === typeof location ? '' : location.search);
}

/** Any `?enterprise` / `?enterprise-*` param turns the fixture on. Nothing else does. */
export function isEnterpriseEnabled(): boolean {
  for (const key of search().keys()) {
    if (key === EnterpriseParam.ENABLED || key.startsWith(PARAM_PREFIX)) return true;
  }
  return false;
}

function readCount(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (null === raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function readEnterpriseConfig(): EnterpriseConfig {
  const p = search();
  return {
    rows: readCount(p, EnterpriseParam.ROWS, EnterpriseDefault.ROWS),
    cols: readCount(p, EnterpriseParam.COLS, EnterpriseDefault.COLS),
    depth: readCount(p, EnterpriseParam.DEPTH, EnterpriseDefault.DEPTH),
    pollHz: readCount(p, EnterpriseParam.POLL_HZ, EnterpriseDefault.POLL_HZ),
    churnMs: readCount(p, EnterpriseParam.CHURN_MS, EnterpriseDefault.CHURN_MS),
    churnNodes: readCount(p, EnterpriseParam.CHURN_NODES, EnterpriseDefault.CHURN_NODES),
    hotMs: readCount(p, EnterpriseParam.HOT_MS, EnterpriseDefault.HOT_MS),
  };
}
