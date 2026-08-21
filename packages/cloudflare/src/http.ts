export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

const STATUS_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reticle Cloudflare Runner</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f8fafc; background: #07111f; }
    main { width: min(680px, calc(100% - 32px)); padding: 48px; border: 1px solid #24344a; border-radius: 24px; background: linear-gradient(145deg, #101d2f, #0a1524); box-shadow: 0 28px 80px #0008; }
    .status { display: inline-flex; gap: 8px; align-items: center; padding: 7px 12px; border: 1px solid #14532d; border-radius: 999px; color: #86efac; background: #052e1b; font-size: 13px; font-weight: 700; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 18px #4ade80; }
    h1 { margin: 24px 0 12px; font-size: clamp(32px, 7vw, 52px); line-height: 1; letter-spacing: -0.045em; }
    p { color: #aebed2; font-size: 17px; line-height: 1.6; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 14px 24px; margin: 32px 0; padding: 22px; border-radius: 16px; background: #07111f; }
    dt { color: #71839a; } dd { margin: 0; font-weight: 650; }
    a { color: #7dd3fc; text-decoration: none; } a:hover { text-decoration: underline; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #c4b5fd; }
    footer { color: #71839a; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <span class="status"><span class="dot"></span>READY</span>
    <h1>Reticle Cloudflare Runner</h1>
    <p>Remote browser verification is online. Reticle can upload flows and run them in isolated, parallel Cloudflare Browser Run sessions.</p>
    <dl>
      <dt>Runtime</dt><dd>Cloudflare Workers</dd>
      <dt>Browser</dt><dd>Cloudflare Browser Run</dd>
      <dt>API</dt><dd><code>/v1/*</code> · bearer protected</dd>
      <dt>Health</dt><dd><a href="/health">View JSON health check →</a></dd>
    </dl>
    <footer>No project data or credentials are exposed on this page.</footer>
  </main>
</body>
</html>`;

export function publicResponse(request: Request): Response | undefined {
  if ('GET' !== request.method) return undefined;
  const pathname = new URL(request.url).pathname;
  if ('/health' === pathname) {
    return json({ ok: true, service: 'reticle-cloudflare', browser: 'cloudflare' });
  }
  if ('/' !== pathname) return undefined;
  return new Response(STATUS_PAGE, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
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
