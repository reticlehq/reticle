export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Constant-work string comparison so a bad bearer does not leak a useful prefix timing signal. */
export function tokenMatches(candidate: string, expected: string): boolean {
  const max = Math.max(candidate.length, expected.length);
  let mismatch = candidate.length ^ expected.length;
  for (let index = 0; index < max; index += 1) {
    mismatch |= (candidate.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return 0 === mismatch;
}

export function authorized(request: Request, expected: string | undefined): boolean {
  if (expected === undefined || 0 === expected.length) return false;
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return tokenMatches(header.slice(prefix.length), expected);
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (
    4 !== parts.length ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first = 0, second = 0] = parts;
  return (
    10 === first ||
    127 === first ||
    (169 === first && 254 === second) ||
    (172 === first && second >= 16 && second <= 31) ||
    (192 === first && 168 === second) ||
    0 === first
  );
}

/** Reject literal local/private targets; an optional allowlist narrows public previews further. */
export function previewAllowed(raw: string, allowlist: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if ('http:' !== url.protocol && 'https:' !== url.protocol) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    'localhost' === host ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    '::1' === host ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:') ||
    privateIpv4(host)
  ) {
    return false;
  }
  const allowed = (allowlist ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (0 === allowed.length) return true;
  return allowed.some((entry) => (entry.startsWith('.') ? host.endsWith(entry) : host === entry));
}
