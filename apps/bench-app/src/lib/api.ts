/** Thin client for the demo backend (apps/api on:8787). Real fetches → real Reticle network events. */
export const API_BASE = 'http://localhost:8787';
const BASE = API_BASE;

let token = '';

/** The bearer the API requires. Exported so other callers (the TanStack panel) authenticate the same
 *  way rather than inventing a second auth path. */
export function authToken(): string {
  return token;
}

interface ApiResult {
  method: string;
  path: string;
  status: number | 'ERR';
  ms: number;
  ok: boolean;
}

async function timed(
  method: string,
  path: string,
  init?: RequestInit,
): Promise<{ res: Response | null; r: ApiResult }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, { method, ...init });
    return {
      res,
      r: { method, path, status: res.status, ms: Math.round(performance.now() - t0), ok: res.ok },
    };
  } catch {
    return {
      res: null,
      r: { method, path, status: 'ERR', ms: Math.round(performance.now() - t0), ok: false },
    };
  }
}

export async function login(
  email: string,
  password: string,
): Promise<{ ok: boolean; r: ApiResult }> {
  const { res, r } = await timed('POST', '/api/login', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res !== null && res.ok) {
    const data = (await res.json()) as { token: string };
    token = data.token;
  }
  return { ok: res?.ok ?? false, r };
}

export async function generateScript(
  prompt: string,
): Promise<{ script: string; source: string; r: ApiResult }> {
  const { res, r } = await timed('POST', '/api/generate-script', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt }),
  });
  if (res !== null && res.ok) {
    const data = (await res.json()) as { script: string; source: string };
    return { ...data, r };
  }
  return { script: '', source: 'error', r };
}

/** Cheap unauthenticated GET — the background-poll target for the enterprise-scale fixture. */
export async function health(): Promise<ApiResult> {
  const { r } = await timed('GET', '/api/health');
  return r;
}

/** Each fault is a distinct real failure mode (404/500/cors/wrong-format/wrong-data). */
export async function fault(kind: string): Promise<ApiResult> {
  const authed = 'wrong-data' === kind;
  const { r } = await timed(
    'GET',
    `/api/broken/${kind}`,
    authed ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  );
  return r;
}
