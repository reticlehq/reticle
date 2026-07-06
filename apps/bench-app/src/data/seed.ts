/** Deterministic seed data (seeded PRNG → stable across reloads, for filming + e2e). */

export type Env = 'production' | 'staging' | 'preview';
export type DeployStatus = 'live' | 'building' | 'failed' | 'queued';

export interface Deployment {
  id: number;
  service: string;
  env: Env;
  status: DeployStatus;
  region: string;
  durationMs: number;
  author: string;
  commit: string;
  createdAt: string;
  // Internal bookkeeping that lives in the store but is NEVER rendered in any view/component
  // (audited: absent from DeployTable, DeployDrawer, Overview, and every other JSX). These exist so a
  // store-tamper regression can corrupt a field with NO on-screen shadow — a DOM/pixel tool has
  // nothing to read, only a state read proves the value wrong.
  costUsd: number;
  checksum: string;
}

export interface Kpi {
  key: string;
  label: string;
  value: number;
  suffix?: string;
  delta: number;
  spark: number[];
}

export interface ActivityItem {
  id: number;
  kind: 'deploy' | 'alert' | 'scale' | 'rollback';
  text: string;
  at: string;
}

/** mulberry32 — tiny deterministic PRNG so the dashboard looks identical every run. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVICES = [
  'api-gateway',
  'auth-service',
  'web-frontend',
  'billing-worker',
  'search-indexer',
  'media-encoder',
  'notification-hub',
  'analytics-pipeline',
  'edge-router',
  'session-store',
  'image-proxy',
  'webhook-relay',
];
const REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-south-1',
  'ap-northeast-1',
];
const AUTHORS = ['kira', 'devon', 'mara', 'soren', 'priya', 'leo', 'nadia', 'theo'];
const STATUSES: DeployStatus[] = ['live', 'live', 'live', 'building', 'queued', 'failed'];

const pick = <T>(arr: readonly T[], r: number): T => arr[Math.floor(r * arr.length)] as T;

/** 40 deployments — small enough that the WHOLE store fits under reticle_state's transport node
 * budget (MAX_TOTAL_NODES=1000). A larger array exhausts the budget and every store slice
 * serialized after `deployments` collapses to "[TRUNCATED]", making those paths unreadable. */
export function seedDeployments(count = 40): Deployment[] {
  const r = rng(0xc0ffee);
  const out: Deployment[] = [];
  for (let i = 0; i < count; i += 1) {
    const service = pick(SERVICES, r());
    out.push({
      id: 4000 - i,
      service,
      env: pick<Env>(['production', 'staging', 'preview'], r()),
      status: pick(STATUSES, r()),
      region: pick(REGIONS, r()),
      durationMs: 800 + Math.floor(r() * 240000),
      author: pick(AUTHORS, r()),
      commit: Math.floor(r() * 0xfffffff)
        .toString(16)
        .padStart(7, '0')
        .slice(0, 7),
      createdAt: `${Math.floor(r() * 59)}m ago`,
      // Deterministic, never-rendered. Not drawn from the PRNG so the visible dashboard is unchanged
      // and the exact value is knowable for a state-invariant oracle. row0: 1200 / '9a3f00'.
      costUsd: 1200 + i * 15,
      checksum: (0x9a3f00 + i).toString(16),
    });
  }
  return out;
}

export function seedKpis(): Kpi[] {
  const r = rng(0x1d);
  const spark = (n: number, base: number): number[] =>
    Array.from({ length: n }, (_, i) => base + Math.round((r() - 0.4) * base * 0.5) + i);
  return [
    { key: 'deploys', label: 'Deploys today', value: 312, delta: 12.4, spark: spark(16, 18) },
    {
      key: 'success',
      label: 'Success rate',
      value: 99.2,
      suffix: '%',
      delta: 0.6,
      spark: spark(16, 96),
    },
    {
      key: 'p95',
      label: 'p95 latency',
      value: 142,
      suffix: 'ms',
      delta: -8.1,
      spark: spark(16, 150),
    },
    { key: 'services', label: 'Active services', value: 48, delta: 4.0, spark: spark(16, 44) },
  ];
}

export function seedActivity(): ActivityItem[] {
  return [
    { id: 1, kind: 'deploy', text: 'api-gateway shipped to production · us-east-1', at: '2m' },
    { id: 2, kind: 'scale', text: 'analytics-pipeline scaled 6 → 11 replicas', at: '9m' },
    { id: 3, kind: 'alert', text: 'billing-worker p95 latency above 400ms', at: '14m' },
    { id: 4, kind: 'deploy', text: 'web-frontend preview deployed by mara', at: '21m' },
    { id: 5, kind: 'rollback', text: 'search-indexer rolled back to a31f0c9', at: '33m' },
    { id: 6, kind: 'deploy', text: 'auth-service shipped to staging · eu-west-1', at: '41m' },
  ];
}

/** 32-point "requests/min" series for the overview area chart. */
export function seedSeries(): number[] {
  const r = rng(0x5eed);
  let v = 60;
  return Array.from({ length: 32 }, () => {
    v += (r() - 0.45) * 22;
    v = Math.max(24, Math.min(118, v));
    return Math.round(v);
  });
}
