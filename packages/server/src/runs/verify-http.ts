/**
 * The token-guarded HTTP verify endpoint — how a host platform (OEM/design partner) or CI drives a
 * verdict from its own pipeline, with no MCP stdio and no human. The request handler is PURE (takes a
 * parsed request, returns a status + body), so it is fully testable without binding a socket; a thin
 * node:http adapter wires it to the wire. Localhost-bound by design; a configured token adds defence
 * in depth (timing-safe compared). An optional persist hook writes the run via RunStore.
 */

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  RunAgentKind,
  RunEnv,
  RunFramework,
  RunProfile,
  RunTrigger,
  type ReticleVerificationRun,
} from '@reticle/protocol';
import type { ReticleRunner, VerifyOptions } from './reticle-runner.js';

/** The POST route a partner pipeline calls to get a verdict. */
export const VERIFY_PATH = '/verify';

/** Lenient request body — every field optional; sane defaults are filled by toVerifyOptions. */
const VerifyRequestSchema = z.object({
  names: z.array(z.string()).optional(),
  project: z
    .object({
      name: z.string().optional(),
      framework: z.nativeEnum(RunFramework).optional(),
      commit: z.string().optional(),
      env: z.nativeEnum(RunEnv).optional(),
      previewUrl: z.string().optional(),
    })
    .optional(),
  agent: z
    .object({
      id: z.string().optional(),
      kind: z.nativeEnum(RunAgentKind).optional(),
      model: z.string().optional(),
    })
    .optional(),
  trigger: z
    .object({
      kind: z.nativeEnum(RunTrigger).optional(),
      diffRef: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  profile: z.nativeEnum(RunProfile).optional(),
});
type VerifyRequestBody = z.infer<typeof VerifyRequestSchema>;

/** Map a parsed request into VerifyOptions, defaulting the required pipeline fields. */
function toVerifyOptions(body: VerifyRequestBody): VerifyOptions {
  const project: VerifyOptions['project'] = {
    name: body.project?.name ?? 'app',
    framework: body.project?.framework ?? RunFramework.OTHER,
    ...(body.project?.commit !== undefined ? { commit: body.project.commit } : {}),
    ...(body.project?.env !== undefined ? { env: body.project.env } : {}),
    ...(body.project?.previewUrl !== undefined ? { previewUrl: body.project.previewUrl } : {}),
  };
  const agent: VerifyOptions['agent'] = {
    id: body.agent?.id ?? 'oem-pipeline',
    kind: body.agent?.kind ?? RunAgentKind.OEM_PIPELINE,
    ...(body.agent?.model !== undefined ? { model: body.agent.model } : {}),
  };
  const trigger: VerifyOptions['trigger'] = {
    kind: body.trigger?.kind ?? RunTrigger.OEM,
    ...(body.trigger?.diffRef !== undefined ? { diffRef: body.trigger.diffRef } : {}),
    ...(body.trigger?.note !== undefined ? { note: body.trigger.note } : {}),
  };
  return {
    ...(body.names !== undefined ? { names: body.names } : {}),
    project,
    agent,
    trigger,
    profile: body.profile ?? RunProfile.PROD_PREVIEW,
  };
}

/** Constant-time token check. Empty expected token ⇒ open (localhost-only deployments). */
export function tokenOk(provided: string | undefined, expected: string): boolean {
  if (expected.length === 0) return true;
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The parsed request the pure handler operates on (decoupled from node:http). */
export interface VerifyHttpRequest {
  method: string;
  path: string;
  token?: string;
  body: unknown;
}

export interface VerifyHttpResponse {
  status: number;
  body: { run: ReticleVerificationRun } | { error: string };
}

/**
 * Pure verify handler. Routes/guards, parses the body, runs the verify, optionally persists the run,
 * and returns a status + body. No sockets, no globals — a test calls it directly.
 */
export async function handleVerifyRequest(
  req: VerifyHttpRequest,
  runner: ReticleRunner,
  expectedToken: string,
  persist?: (run: ReticleVerificationRun) => Promise<void>,
): Promise<VerifyHttpResponse> {
  if (req.path !== VERIFY_PATH) return { status: 404, body: { error: 'not found' } };
  if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
  if (!tokenOk(req.token, expectedToken)) return { status: 401, body: { error: 'unauthorized' } };

  const parsed = VerifyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return { status: 400, body: { error: 'invalid request body' } };

  try {
    const run = await runner.verify(toVerifyOptions(parsed.data));
    if (persist !== undefined) await persist(run);
    return { status: 200, body: { run } };
  } catch {
    return { status: 500, body: { error: 'verify failed' } };
  }
}
