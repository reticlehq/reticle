import {
  ReticleVerificationRunSchema,
  type FlowFile,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import type { ProjectRunUpload, VerificationResponse } from './contracts.js';

const FLOW_PREFIX = 'flows/';
const RUN_PREFIX = 'runs/';
const PROJECT_RUN_PREFIX = 'project-runs/';
const VERIFICATION_PREFIX = 'verifications/';
const R2_PAGE_LIMIT = 1_000;
const DELETE_BATCH_SIZE = 1_000;
const MAX_VERIFICATION_RUNS = 1_000;
const MAX_PROJECT_RUNS = 2_000;
const MAX_SERVER_VERIFICATIONS = 1_000;

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function flowKey(name: string, projectId?: string): string {
  const project = projectId === undefined ? '' : `${segment(projectId)}/`;
  return `${FLOW_PREFIX}${project}${segment(name)}.json`;
}

export async function putFlow(bucket: R2Bucket, flow: FlowFile, projectId?: string): Promise<void> {
  await bucket.put(flowKey(flow.name, projectId), JSON.stringify(flow), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function getFlow(
  bucket: R2Bucket,
  name: string,
  projectId?: string,
  legacyProjectId = 'default',
): Promise<FlowFile | null> {
  let object = await bucket.get(flowKey(name, projectId));
  if (null === object && projectId === legacyProjectId) object = await bucket.get(flowKey(name));
  return null === object ? null : object.json<FlowFile>();
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix,
      limit: R2_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
}

export async function retainNewest(
  bucket: R2Bucket,
  prefix: string,
  maximum: number,
): Promise<void> {
  const objects = await listAllObjects(bucket, prefix);
  const excess = objects
    .sort((left, right) => {
      const time = left.uploaded.getTime() - right.uploaded.getTime();
      return 0 === time ? left.key.localeCompare(right.key) : time;
    })
    .slice(0, Math.max(0, objects.length - maximum));
  for (let index = 0; index < excess.length; index += DELETE_BATCH_SIZE) {
    await bucket.delete(excess.slice(index, index + DELETE_BATCH_SIZE).map((entry) => entry.key));
  }
}

export async function putVerificationRun(
  bucket: R2Bucket,
  run: ReticleVerificationRun,
): Promise<void> {
  await bucket.put(`${RUN_PREFIX}${segment(run.runId)}.json`, JSON.stringify(run), {
    httpMetadata: { contentType: 'application/json' },
  });
  await retainNewest(bucket, RUN_PREFIX, MAX_VERIFICATION_RUNS);
}

export async function putVerificationReport(
  bucket: R2Bucket,
  report: VerificationResponse,
): Promise<void> {
  await bucket.put(
    `${VERIFICATION_PREFIX}${segment(report.verificationId)}.json`,
    JSON.stringify(report),
    { httpMetadata: { contentType: 'application/json' } },
  );
  await retainNewest(bucket, VERIFICATION_PREFIX, MAX_SERVER_VERIFICATIONS);
}

export async function listVerificationRuns(bucket: R2Bucket): Promise<ReticleVerificationRun[]> {
  const listed = await listAllObjects(bucket, RUN_PREFIX);
  const runs = await Promise.all(
    listed.map(async (entry) => {
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
  await retainNewest(bucket, `${PROJECT_RUN_PREFIX}${project}/`, MAX_PROJECT_RUNS);
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
  const listed = await listAllObjects(bucket, `${PROJECT_RUN_PREFIX}${project}/`);
  const rows = (
    await Promise.all(
      listed.map(async (entry) => {
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
