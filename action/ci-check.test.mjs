import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  NO_URL,
  PROTECTED_NO_SECRET,
  PROTECTED_WRONG_SECRET,
  SKIP_NOT_SUCCESS,
  checkPayload,
  decide,
  flowFileName,
  openPreview,
  previewUrl,
  prNumber,
  readResults,
  suiteFlows,
} from './ci-check.mjs';

describe('the check the action posts', () => {
  it('carries the repo, commit, ref, url and every journey, plus the PR number on a pull request', () => {
    const payload = checkPayload({
      env: { GITHUB_REPOSITORY: 'acme/shop', GITHUB_SHA: 'abc', GITHUB_REF: 'refs/pull/7/merge' },
      url: 'https://preview.example',
      results: [{ journey: 'checkout', verdict: 'yes' }],
      event: { pull_request: { number: 7 } },
    });
    expect(payload).toEqual({
      repo: 'acme/shop',
      sha: 'abc',
      pr: 7,
      ref: 'refs/pull/7/merge',
      url: 'https://preview.example',
      results: [{ journey: 'checkout', verdict: 'yes' }],
    });
  });

  // The check's page offers a replay only for a journey whose result names the run it pushed.
  it('forwards the run each journey came from, so the check can replay it', () => {
    const results = readResults(
      '{"verdict":"no","results":[{"journey":"a","verdict":"no","runId":"run-1"}]}',
    );
    expect(checkPayload({ env: {}, url: 'u', results, event: {} }).results).toEqual([
      { journey: 'a', verdict: 'no', runId: 'run-1' },
    ]);
  });

  it('leaves the PR out on a push', () => {
    expect(prNumber({})).toBeUndefined();
    expect(checkPayload({ env: {}, url: 'u', results: [], event: {} })).not.toHaveProperty('pr');
  });
});

describe('how the job ends', () => {
  it('fails on a no, and prints where the details are', () => {
    expect(
      decide({ status: 200, body: { verdict: 'no', detailsUrl: 'https://d' }, resultCount: 2 }),
    ).toEqual({ code: 1, lines: ['Reticle verdict: no', 'Details: https://d'] });
  });

  it('fails on a trial that needs a card, with the platform message', () => {
    expect(
      decide({
        status: 402,
        body: { error: 'needs_card', message: 'Your trial has ended.' },
        resultCount: 2,
      }),
    ).toEqual({ code: 1, lines: ['Your trial has ended.'] });
  });

  it('passes on a yes', () => {
    expect(decide({ status: 200, body: { verdict: 'yes' }, resultCount: 1 }).code).toBe(0);
  });

  it('never passes a run that verified nothing', () => {
    expect(decide({ status: 200, body: { verdict: 'unknown' }, resultCount: 0 }).code).toBe(1);
  });

  it('fails when the platform refused the check', () => {
    expect(decide({ status: 401, body: { error: 'unauthorized' }, resultCount: 1 }).code).toBe(1);
  });
});

describe('what verify and the suite hand over', () => {
  it('reads the per-journey verdicts, and none from a file that is not the shape', () => {
    expect(readResults('{"verdict":"yes","results":[{"journey":"a","verdict":"yes"}]}')).toEqual([
      { journey: 'a', verdict: 'yes' },
    ]);
    expect(readResults('not json')).toEqual([]);
  });

  it('takes the suite as an array or under flows, and keeps only named flows', () => {
    expect(suiteFlows([{ name: 'a' }, {}])).toEqual([{ name: 'a' }]);
    expect(suiteFlows({ flows: [{ name: 'b' }] })).toEqual([{ name: 'b' }]);
    expect(suiteFlows(null)).toEqual([]);
  });

  it('never lets a flow name write outside the flows directory', () => {
    expect(flowFileName('../../etc/passwd')).toBe('-etc-passwd.json');
    expect(flowFileName('checkout')).toBe('checkout.json');
  });
});

describe('which URL the check verifies', () => {
  const vercel = {
    deployment_status: {
      state: 'success',
      target_url: 'https://shop-git-fix-acme.vercel.app',
      environment_url: 'https://shop-git-fix-acme.vercel.app',
    },
  };
  // A provider can point target_url at its deploy log. The environment URL is the preview itself.
  const netlify = {
    deployment_status: {
      state: 'success',
      target_url: 'https://app.netlify.com/sites/shop/deploys/abc',
      environment_url: 'https://deploy-preview-7--shop.netlify.app',
    },
  };

  it('reads the Vercel preview from a successful deployment_status event', () => {
    expect(previewUrl({ input: '', event: vercel })).toEqual({
      url: 'https://shop-git-fix-acme.vercel.app',
    });
  });

  it('reads the Netlify preview from environment_url, not from the deploy log', () => {
    expect(previewUrl({ input: '', event: netlify })).toEqual({
      url: 'https://deploy-preview-7--shop.netlify.app',
    });
  });

  it('uses target_url when the event has no environment_url', () => {
    const event = { deployment_status: { state: 'success', target_url: 'https://p.example' } };
    expect(previewUrl({ input: '', event })).toEqual({ url: 'https://p.example' });
  });

  it('skips a deployment that did not succeed, also when a url is typed', () => {
    const event = { deployment_status: { state: 'pending', target_url: 'https://p.example' } };
    expect(previewUrl({ input: '', event })).toEqual({ skip: SKIP_NOT_SUCCESS('pending') });
    expect(previewUrl({ input: 'https://typed.example', event })).toEqual({
      skip: SKIP_NOT_SUCCESS('pending'),
    });
  });

  it('lets the url input win over the event', () => {
    expect(previewUrl({ input: 'https://typed.example', event: vercel })).toEqual({
      url: 'https://typed.example',
    });
  });

  it('refuses when there is no url input and no deployment', () => {
    expect(previewUrl({ input: '', event: { pull_request: { number: 7 } } })).toEqual({
      error: NO_URL,
    });
  });
});

/**
 * A stand-in for a Vercel preview behind Deployment Protection. It answers 401 to a request with no
 * bypass. With the right header and `x-vercel-set-bypass-cookie: true`, it redirects and sets a
 * cookie, as Vercel does. A request that carries that cookie gets the page.
 */
async function protectedPreview(secret) {
  const server = createServer((req, res) => {
    if ((req.headers.cookie ?? '').includes(`_vercel_jwt=ok-${secret}`)) {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>app</p>');
      return;
    }
    if (req.headers['x-vercel-protection-bypass'] !== secret) {
      res.writeHead(401, { server: 'Vercel' }).end('Authentication Required');
      return;
    }
    if (req.headers['x-vercel-set-bypass-cookie'] === 'true') {
      res
        .writeHead(307, {
          location: req.url ?? '/',
          'set-cookie': `_vercel_jwt=ok-${secret}; Path=/; HttpOnly; SameSite=Lax`,
        })
        .end();
      return;
    }
    res.writeHead(200).end('<p>app</p>');
  });
  return listen(server);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((done) => server.close(done)),
  };
}

describe('a preview behind protection', () => {
  it('says which secret is missing when the preview answers 401', async () => {
    const preview = await protectedPreview('s3cret');
    try {
      expect(await openPreview({ url: preview.url, secret: '' })).toEqual({
        error: PROTECTED_NO_SECRET(401),
      });
    } finally {
      await preview.close();
    }
  });

  it('says the secret is wrong when the preview still answers 401 with it', async () => {
    const preview = await protectedPreview('s3cret');
    try {
      expect(await openPreview({ url: preview.url, secret: 'wrong' })).toEqual({
        error: PROTECTED_WRONG_SECRET(401),
      });
    } finally {
      await preview.close();
    }
  });

  it('turns the bypass secret into a storage state whose cookie opens the preview', async () => {
    const preview = await protectedPreview('s3cret');
    try {
      const opened = await openPreview({ url: preview.url, secret: 's3cret' });
      const cookies = opened.storageState?.cookies ?? [];
      expect(cookies.map((c) => [c.name, c.domain, c.path])).toEqual([
        ['_vercel_jwt', '127.0.0.1', '/'],
      ]);
      // The replay's browser sends this cookie on each request, so the page answers.
      const page = await fetch(preview.url, {
        headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
      });
      expect(page.status).toBe(200);
    } finally {
      await preview.close();
    }
  });

  it('needs no storage state for a preview that is open', async () => {
    const open = await listen(createServer((_req, res) => res.writeHead(200).end('ok')));
    try {
      expect(await openPreview({ url: open.url, secret: '' })).toEqual({});
    } finally {
      await open.close();
    }
  });
});
