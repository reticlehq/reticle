import { DurableObject } from 'cloudflare:workers';
import { launch } from '@cloudflare/playwright';
import { FlowFileSchema } from '@reticlehq/core';
import {
  RemoteFlowStatus,
  RunnerRequestSchema,
  type RemoteFlowResult,
  type RunnerRequest,
  type VerificationResponse,
} from './contracts.js';
import type { Env } from './env.js';
import { json, previewAllowed } from './http.js';
import { pageAdapter, replayFlow } from './replay.js';
import { getFlow } from './store.js';

function verdictOf(flows: RemoteFlowResult[]): RemoteFlowStatus {
  if (flows.some((flow) => RemoteFlowStatus.FAIL === flow.status)) return RemoteFlowStatus.FAIL;
  if (flows.some((flow) => RemoteFlowStatus.UNVERIFIED === flow.status)) {
    return RemoteFlowStatus.UNVERIFIED;
  }
  return RemoteFlowStatus.PASS;
}

function summaryOf(flows: RemoteFlowResult[], verdict: RemoteFlowStatus): string {
  const passed = flows.filter((flow) => RemoteFlowStatus.PASS === flow.status).length;
  const failed = flows.filter((flow) => RemoteFlowStatus.FAIL === flow.status).length;
  const unverified = flows.filter((flow) => RemoteFlowStatus.UNVERIFIED === flow.status).length;
  return `${verdict}: ${String(passed)} passed, ${String(failed)} failed, ${String(unverified)} unverified`;
}

export class VerificationRunner extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if ('/run' !== new URL(request.url).pathname || 'POST' !== request.method) {
      return json({ error: 'not_found' }, 404);
    }
    const parsed = RunnerRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: 'bad_request' }, 400);
    if (!previewAllowed(parsed.data.previewUrl, this.env.RETICLE_ALLOWED_HOSTS)) {
      return json({ error: 'preview_url_not_allowed' }, 400);
    }
    return json(await this.run(parsed.data));
  }

  private async run(request: RunnerRequest): Promise<VerificationResponse> {
    const browser = await launch(this.env.BROWSER, { keep_alive: 60_000 });
    const results: RemoteFlowResult[] = [];
    try {
      for (const name of request.flows) {
        const raw = await getFlow(this.env.ARTIFACTS, name);
        const parsed = FlowFileSchema.safeParse(raw);
        if (!parsed.success) {
          results.push({ name, status: RemoteFlowStatus.UNVERIFIED, detail: 'flow is missing' });
          continue;
        }
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          results.push(await replayFlow(pageAdapter(page), request.previewUrl, parsed.data));
        } catch {
          results.push({ name, status: RemoteFlowStatus.FAIL, detail: 'browser execution failed' });
        } finally {
          await context.close().catch(() => undefined);
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
    const verdict = verdictOf(results);
    const response: VerificationResponse = {
      verificationId: request.verificationId,
      verdict,
      flows: results,
      summary: summaryOf(results, verdict),
    };
    await this.env.ARTIFACTS.put(
      `verifications/${request.verificationId}.json`,
      JSON.stringify(response),
      { httpMetadata: { contentType: 'application/json' } },
    );
    return response;
  }
}
