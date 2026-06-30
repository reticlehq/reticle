/**
 * The Builder API as a connect-style middleware, so it can be mounted in the Vite dev server (same
 * origin as the instrumented Builder UI) instead of a separate HTTP server. Endpoints:
 *   GET  /api/builder-config        → { previewUrl }
 *   POST /api/verify { bug, engine } → { bug, blind, reticle }   (engine: 'scripted' | 'live')
 *   POST /api/repair { bug }       → repair-loop transcript
 *
 * The inner Reticle (verify/repair) launches its own bridge + headless browser — this is the INNER
 * layer of the self-test loop. Runs are serialized (one bridge/browser at a time).
 */
import { verifyPreview } from './verify-live.mjs';
import { repairLoop } from './repair-loop.mjs';
import { runLiveAgent } from './qa-agent-live.mjs';

export function createBuilderApi({ previewUrl, bridgePort }) {
  let busy = false;

  const blindGate = async (bug) => {
    const page = await fetch(`${previewUrl}/?bug=${bug}`);
    await fetch(`${previewUrl}/api/reset`, { method: 'DELETE', headers: { 'x-bug': bug } });
    const post = await fetch(`${previewUrl}/api/expenses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bug': bug },
      body: JSON.stringify({ amount: '42', category: 'food', note: '' }),
    });
    return page.ok && post.ok ? 'pass' : 'fail';
  };

  const send = (res, code, body) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve({});
        }
      });
    });

  return async function builderApi(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/builder-config') {
      return send(res, 200, { previewUrl });
    }

    if (req.method === 'POST' && url.pathname === '/api/verify') {
      if (busy) return send(res, 429, { error: 'a verification is already running' });
      const body = await readBody(req);
      const bug = body.bug ?? 'none';
      const engine = body.engine === 'live' ? 'live' : 'scripted';
      busy = true;
      try {
        const blind = await blindGate(bug);
        if (engine === 'live') {
          const v = await runLiveAgent({ bug, previewUrl, bridgePort });
          send(res, 200, {
            bug,
            blind,
            reticle: { engine: 'live', status: v.status, summary: v.summary, failures: v.failures, steps: v.steps, durationMs: v.durationMs, model: v.model },
          });
        } else {
          const reticle = await verifyPreview({ bug, previewUrl, bridgePort });
          send(res, 200, { bug, blind, reticle: { engine: 'scripted', ...reticle } });
        }
      } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } finally {
        busy = false;
      }
      return undefined;
    }

    if (req.method === 'POST' && url.pathname === '/api/repair') {
      if (busy) return send(res, 429, { error: 'a verification is already running' });
      const body = await readBody(req);
      const bug = body.bug ?? 'none';
      busy = true;
      try {
        const result = await repairLoop({ bug, previewUrl, bridgePort });
        send(res, 200, result);
      } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } finally {
        busy = false;
      }
      return undefined;
    }

    return next();
  };
}
