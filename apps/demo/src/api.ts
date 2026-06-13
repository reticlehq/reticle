const BASE = 'http://localhost:8787';

export interface Item {
  id: number;
  name: string;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function login(email: string, password: string): Promise<{ token: string }> {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('invalid email or password');
  return json<{ token: string }>(res);
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

export async function fetchItems(token: string): Promise<{ items: Item[]; total: number }> {
  const res = await fetch(`${BASE}/api/items`, { headers: auth(token) });
  if (!res.ok) throw new Error(`items failed: ${res.status}`);
  return json<{ items: Item[]; total: number }>(res);
}

export async function addItem(
  token: string,
  name: string,
): Promise<{ accepted: boolean; visibleInMs: number }> {
  const res = await fetch(`${BASE}/api/items`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`add failed: ${res.status}`);
  return json<{ accepted: boolean; visibleInMs: number }>(res);
}

export async function generateScript(
  token: string,
  prompt: string,
): Promise<{ script: string; source: string }> {
  const res = await fetch(`${BASE}/api/generate-script`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(`generate failed: ${res.status}`);
  return json<{ script: string; source: string }>(res);
}

export async function scoreFile(
  token: string,
  filename: string,
  size: number,
): Promise<{ score: number; verdict: string }> {
  const res = await fetch(`${BASE}/api/score`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ filename, size }),
  });
  if (!res.ok) throw new Error(`score failed: ${res.status}`);
  return json<{ score: number; verdict: string }>(res);
}

export type BrokenKind = '404' | '500' | 'cors' | 'wrong-format' | 'wrong-data';

/** Call a deliberately-broken endpoint; throws on the various failure modes. */
export async function callBroken(kind: BrokenKind, token: string): Promise<unknown> {
  const headers = kind === 'wrong-data' ? auth(token) : undefined;
  const res = await fetch(`${BASE}/api/broken/${kind}`, headers ? { headers } : undefined);
  if (!res.ok) throw new Error(`${kind} → HTTP ${res.status}`);
  const data = await json<{ items?: unknown }>(res); // wrong-format throws here; wrong-data lacks items
  if (kind === 'wrong-data' && data.items === undefined) {
    throw new Error('wrong-data → response missing `items`');
  }
  return data;
}
