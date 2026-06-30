import { z } from 'zod';
import { VISUAL_NO_PROVIDER_RECOMMENDATION, VisualReason } from '@reticlehq/protocol';
import { ReticleTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import type { RealInputProvider } from './real-input.js';
import type { MockRule } from './network-mock.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'Active session ID from reticle_sessions. Omit when only one browser session is open.',
    ),
};

/** A provider that can install network mocks — narrows the optional capability so callers branch once. */
type MockCapable = RealInputProvider & {
  setMocks(sessionUrl: string, rules: MockRule[]): Promise<boolean>;
};

function mockProvider(deps: ToolDeps): MockCapable | undefined {
  const p = deps.realInput;
  return p !== undefined && typeof p.setMocks === 'function' ? (p as MockCapable) : undefined;
}

const ruleShape = z.object({
  urlContains: z
    .string()
    .min(1)
    .describe('Substring the request URL must contain, e.g. "/api/pay".'),
  method: z.string().optional().describe('Optional method filter (GET/POST/…), case-insensitive.'),
  status: z.number().int().optional().describe('Fulfill with this HTTP status (default 200).'),
  body: z.string().optional().describe('Response body to fulfill with.'),
  contentType: z.string().optional().describe('Response content type (default application/json).'),
  delayMs: z
    .number()
    .int()
    .optional()
    .describe('Delay (ms) before fulfilling — simulate a slow API.'),
  abort: z
    .boolean()
    .optional()
    .describe('Simulate a network failure (offline) instead of a response.'),
});

/** Narrow the validated tool args into MockRule[], omitting undefined keys (exactOptionalPropertyTypes). */
function toRules(value: unknown): MockRule[] {
  const parsed = z.array(ruleShape).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((r) => {
    const rule: MockRule = { urlContains: r.urlContains };
    if (r.method !== undefined) rule.method = r.method;
    if (r.status !== undefined) rule.status = r.status;
    if (r.body !== undefined) rule.body = r.body;
    if (r.contentType !== undefined) rule.contentType = r.contentType;
    if (r.delayMs !== undefined) rule.delayMs = r.delayMs;
    if (r.abort !== undefined) rule.abort = r.abort;
    return rule;
  });
}

export const NETWORK_MOCK_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.NETWORK_MOCK,
    description:
      'Stub or intercept network requests on the DRIVEN page (needs `reticle drive`): return a 500, ' +
      'force offline (abort), or delay a response — so you can deterministically test error and edge ' +
      'states without touching the backend ("verify the app handles a failed payment"). Pass `mocks` ' +
      '(first matching rule wins); pass an empty array or `clear: true` to turn mocking off.',
    inputSchema: {
      mocks: z.array(ruleShape).optional().describe('Interception rules; omit/empty to clear.'),
      clear: z.boolean().optional().describe('Clear all active mocks (same as mocks: []).'),
      ...sessionIdShape,
    },
    outputSchema: {
      applied: z.boolean(),
      count: z.number(),
      ok: z.boolean().optional(),
      reason: z.string().optional(),
      recommendation: z.string().optional(),
    },
    handler: async (deps, args) => {
      const provider = mockProvider(deps);
      if (provider === undefined) {
        // Mocking needs a browser Reticle drives; a synthetic in-page session can't intercept the network.
        return {
          applied: false,
          count: 0,
          ok: false,
          reason: VisualReason.NO_PROVIDER,
          recommendation: VISUAL_NO_PROVIDER_RECOMMENDATION,
        };
      }
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const rules = args['clear'] === true ? [] : toRules(args['mocks']);
      const applied = await provider.setMocks(session.url, rules);
      return { applied, count: applied ? rules.length : 0 };
    },
  },
];
