/**
 * The document a local dev server actually serves: its CSP header and HTML, read once and failing
 * soft. Shared by `doctor` (is a policy blocking the bridge?) and a lease that never dialled (was
 * it the page's own policy?), which is why it lives beside the dev-server probe and not in either.
 */
/** What a served page said about its policy. The same shape `diagnoseObservedWebCsp` reads. */
export interface ObservedWebDocument {
  url: string;
  headers: string[];
  html: string;
}

const CSP_HEADER = 'content-security-policy';
const DOCUMENT_TIMEOUT_MS = 1_000;
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export type PageRequest = (url: string, init: RequestInit) => Promise<Response>;

interface ConnectedDocument {
  url: string;
  projectId?: string;
}

const requestPage: PageRequest = (url, init) => fetch(url, init);

function loopbackDocumentUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return LOOPBACK_HOSTS.includes(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

function originOf(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** A connected tab for this project, or on its observed origin, disproves a CSP diagnosis. */
export function hasConnectedDocument(
  sessions: readonly ConnectedDocument[],
  documentUrls: readonly string[],
  projectId?: string,
): boolean {
  if (projectId !== undefined && sessions.some((session) => session.projectId === projectId)) {
    return true;
  }
  const origins = new Set(documentUrls.map(originOf).filter((value) => value !== undefined));
  return sessions.some((session) => {
    const origin = originOf(session.url);
    return undefined !== origin && origins.has(origin);
  });
}

/** Read the document a live local dev server actually sends, failing soft like the rest of doctor. */
export async function observeWebDocument(
  rawUrl: string,
  request: PageRequest = requestPage,
): Promise<ObservedWebDocument | undefined> {
  const url = loopbackDocumentUrl(rawUrl);
  if (url === undefined) return undefined;
  try {
    const response = await request(url.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const policy = response.headers.get(CSP_HEADER);
    return {
      url: url.href,
      headers: null === policy ? [] : [policy],
      html: await response.text(),
    };
  } catch {
    return undefined;
  }
}
