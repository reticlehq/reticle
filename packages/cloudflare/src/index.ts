import {
  FlowUploadSchema,
  ProjectRunUploadSchema,
  VerificationRequestSchema,
  VerificationRunUploadSchema,
} from './contracts.js';
import type { Env } from './env.js';
import { authorized, json, previewAllowed } from './http.js';
import { VerificationRunner } from './runner.js';
import {
  listVerificationRuns,
  projectRegression,
  putFlow,
  putProjectRun,
  putVerificationRun,
} from './store.js';

export { VerificationRunner };

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function body(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('body_too_large');
  return JSON.parse(text);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if ('GET' === request.method && '/health' === url.pathname) {
    return json({ ok: true, service: 'reticle-cloudflare', browser: 'cloudflare' });
  }
  if (!url.pathname.startsWith('/v1/')) return json({ error: 'not_found' }, 404);
  if (env.RETICLE_CLOUD_KEY === undefined || 0 === env.RETICLE_CLOUD_KEY.length) {
    return json({ error: 'cloud_key_not_configured' }, 503);
  }
  if (!authorized(request, env.RETICLE_CLOUD_KEY)) return json({ error: 'unauthorized' }, 401);

  if ('GET' === request.method && '/v1/cloud/whoami' === url.pathname) {
    return json({
      projectId: env.RETICLE_PROJECT_ID ?? 'default',
      projectName: env.RETICLE_PROJECT_NAME ?? 'Self-hosted Reticle',
    });
  }

  if ('POST' === request.method && '/v1/flows' === url.pathname) {
    const parsed = FlowUploadSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: 'bad_request' }, 400);
    await putFlow(env.ARTIFACTS, parsed.data.flow);
    return json({ ok: true, name: parsed.data.flow.name }, 201);
  }

  if ('POST' === request.method && '/v1/verifications' === url.pathname) {
    const parsed = VerificationRequestSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: 'bad_request' }, 400);
    if (!previewAllowed(parsed.data.previewUrl, env.RETICLE_ALLOWED_HOSTS)) {
      return json({ error: 'preview_url_not_allowed' }, 400);
    }
    const verificationId = crypto.randomUUID();
    const runner = env.VERIFICATION_RUNNER.get(env.VERIFICATION_RUNNER.idFromName(verificationId));
    return runner.fetch('https://runner/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...parsed.data, verificationId }),
    });
  }

  if ('POST' === request.method && '/v1/runs' === url.pathname) {
    const parsed = VerificationRunUploadSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: 'bad_request' }, 400);
    await putVerificationRun(env.ARTIFACTS, parsed.data);
    return json({ ok: true, runId: parsed.data.runId }, 201);
  }

  if ('GET' === request.method && '/v1/runs' === url.pathname) {
    return json({ runs: await listVerificationRuns(env.ARTIFACTS) });
  }

  if ('POST' === request.method && '/v1/project/runs' === url.pathname) {
    const parsed = ProjectRunUploadSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: 'bad_request' }, 400);
    await putProjectRun(env.ARTIFACTS, parsed.data);
    return json({ ok: true }, 201);
  }

  if ('GET' === request.method && '/v1/project/regression' === url.pathname) {
    const projectId = url.searchParams.get('projectId') ?? undefined;
    return json(await projectRegression(env.ARTIFACTS, projectId));
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof Error && 'body_too_large' === error.message) {
        return json({ error: 'body_too_large' }, 413);
      }
      if (error instanceof SyntaxError) return json({ error: 'bad_request' }, 400);
      return json({ error: 'internal_error' }, 500);
    }
  },
};
