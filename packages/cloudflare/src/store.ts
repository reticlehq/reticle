import {
  ReticleVerificationRunSchema,
  type FlowFile,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import type { ProjectRunUpload } from './contracts.js';

const FLOW_PREFIX = 'flows/';
const RUN_PREFIX = 'runs/';
const PROJECT_RUN_PREFIX = 'project-runs/';

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function flowKey(name: string): string {
  return `${FLOW_PREFIX}${segment(name)}.json`;
}

export async function putFlow(bucket: R2Bucket, flow: FlowFile): Promise<void> {
  await bucket.put(flowKey(flow.name), JSON.stringify(flow), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function getFlow(bucket: R2Bucket, name: string): Promise<FlowFile | null> {
  const object = await bucket.get(flowKey(name));
  return null === object ? null : object.json<FlowFile>();
}

export async function putVerificationRun(
  bucket: R2Bucket,
  run: ReticleVerificationRun,
): Promise<void> {
  await bucket.put(`${RUN_PREFIX}${segment(run.runId)}.json`, JSON.stringify(run), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function listVerificationRuns(bucket: R2Bucket): Promise<ReticleVerificationRun[]> {
  const listed = await bucket.list({ prefix: RUN_PREFIX, limit: 100 });
  const runs = await Promise.all(
    listed.objects.map(async (entry) => {
      const object = await bucket.get(entry.key);
      if (null === object) return null;
      const parsed = ReticleVerificationRunSchema.safeParse(await object.json());
      return parsed.success ? parsed.data : null;
    }),
  );
  return runs
    .filter((run): run is ReticleVerificationRun => null !== run)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function putProjectRun(bucket: R2Bucket, run: ProjectRunUpload): Promise<void> {
  const project = segment(run.projectId ?? '_default');
  const key = `${PROJECT_RUN_PREFIX}${project}/${String(run.at)}-${crypto.randomUUID()}.json`;
  await bucket.put(key, JSON.stringify(run), { httpMetadata: { contentType: 'application/json' } });
}

export interface RegressionReport {
  projectId?: string;
  runs: number;
  latest: ProjectRunUpload[];
  regressions: Array<{ flowName: string; from: string; to: string; at: number }>;
  broken: ProjectRunUpload[];
}

export async function projectRegression(
  bucket: R2Bucket,
  projectId: string | undefined,
): Promise<RegressionReport> {
  const project = segment(projectId ?? '_default');
  const listed = await bucket.list({ prefix: `${PROJECT_RUN_PREFIX}${project}/`, limit: 500 });
  const rows = (
    await Promise.all(
      listed.objects.map(async (entry) => {
        const object = await bucket.get(entry.key);
        return null === object ? null : object.json<ProjectRunUpload>();
      }),
    )
  )
    .filter((row): row is ProjectRunUpload => row !== null)
    .sort((left, right) => right.at - left.at);
  const grouped = new Map<string, ProjectRunUpload[]>();
  for (const row of rows) {
    const group = grouped.get(row.flowName) ?? [];
    group.push(row);
    grouped.set(row.flowName, group);
  }
  const latest = [...grouped.values()].flatMap((group) => group.slice(0, 1));
  const regressions = [...grouped.values()].flatMap((group) => {
    const current = group[0];
    const previous = group[1];
    if (current === undefined || previous === undefined || current.status === previous.status)
      return [];
    return [
      {
        flowName: current.flowName,
        from: previous.status,
        to: current.status,
        at: current.at,
      },
    ];
  });
  const broken = latest.filter((row) => 'pass' !== row.status);
  return {
    ...(projectId === undefined ? {} : { projectId }),
    runs: rows.length,
    latest,
    regressions,
    broken,
  };
}
