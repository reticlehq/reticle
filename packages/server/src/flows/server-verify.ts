/**
 * verify:server delegation. When a project's cloud config sets `verify: 'server'`, the FLOW_VERIFY tool
 * runs the suite on the hosted runner (POST /v1/verifications) instead of replaying in the local browser,
 * and maps the server's report back into the SAME SuiteVerdict the local path returns — so the agent's
 * contract is identical either way. Falls back to local (returns null) when not attached, wrong mode, or
 * there is no reachable preview URL for the server to hit.
 */
import type { SuiteVerdict, SuiteFlowResult } from '@reticlehq/core';
import type { ToolDeps } from '../tools/tools.js';
import { VerifyMode, type ProjectCloud } from '../cloud/cloud-config.js';
import { submitServerVerification, type ServerVerification } from '../cloud/cloud-sync.js';

const PASS = 'pass';
const UNVERIFIED = 'unverified';
const SOURCE = 'reticle-mcp';

/** Map the hosted runner's report onto the local suite-verdict shape (status/total/passed/failed/failures). */
export function toSuiteVerdict(report: ServerVerification): SuiteVerdict {
  const failures: SuiteFlowResult[] = report.flows
    .filter((f) => f.status !== PASS)
    .map((f) => ({
      flow: f.name,
      verdict: 'fail',
      nextAction: `verified on the server — see report ${report.verificationId}`,
    }));
  const total = report.flows.length;
  const passed = total - failures.length;
  const status: 'pass' | 'fail' =
    report.verdict === PASS && 0 === failures.length ? 'pass' : 'fail';
  return { status, total, passed, failed: failures.length, summary: report.summary, failures };
}

/** Run the suite on the hosted runner, or null to signal the caller should replay locally. */
export async function runServerVerify(
  deps: ToolDeps,
  cloud: ProjectCloud,
  sessionId: string | undefined,
  flows: string[],
  parallel?: number,
): Promise<SuiteVerdict | null> {
  if (cloud.verify !== VerifyMode.SERVER || null === cloud.config) return null;
  let previewUrl: string | undefined;
  try {
    previewUrl = deps.sessions.resolve(sessionId).url;
  } catch {
    previewUrl = undefined;
  }
  // The server hits the URL itself; with no URL (or a localhost one it can't reach) fall back to local.
  if (previewUrl === undefined || 0 === previewUrl.length) return null;
  const report = await submitServerVerification(
    {
      previewUrl,
      flows,
      source: SOURCE,
      ...(parallel === undefined ? {} : { parallel }),
      ...(null === cloud.projectId ? {} : { projectId: cloud.projectId }),
    },
    cloud.config,
    (url, init) => fetch(url, init),
  );
  if (null === report) return null;
  // The hosted runner said it couldn't actually verify (e.g. it's not enabled yet). Never surface that as
  // a pass or a fail — fall back to the real local replay so the verdict reflects a browser that ran.
  if (report.verdict === UNVERIFIED) return null;
  return toSuiteVerdict(report);
}
