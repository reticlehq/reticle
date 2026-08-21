const base = process.env.RETICLE_CLOUDFLARE_URL?.replace(/\/$/, '');
const token = process.env.RETICLE_CLOUD_KEY;
if (!base || !token) {
  console.error('set RETICLE_CLOUDFLARE_URL and RETICLE_CLOUD_KEY');
  process.exit(2);
}

const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const flows = ['cloudflare-example-domain-a', 'cloudflare-example-domain-b'].map((name) => ({
  version: 1,
  name,
  createdAt: Date.now(),
  startPath: '/',
  steps: [
    {
      tool: 'reticle_act',
      anchor: { kind: 'role', role: 'link', name: 'Learn more' },
      action: 'click',
      expect: { element: { role: 'heading', name: 'Example Domains' } },
    },
  ],
}));

for (const flow of flows) {
  const upload = await fetch(`${base}/v1/flows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ flow }),
  });
  if (!upload.ok) throw new Error(`flow upload failed: ${upload.status} ${await upload.text()}`);
}

const verification = await fetch(`${base}/v1/verifications`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    previewUrl: 'https://example.com',
    flows: flows.map((flow) => flow.name),
    source: 'cloudflare-smoke',
    parallel: 2,
  }),
});
const report = await verification.json();
console.log(JSON.stringify(report, null, 2));
if (!verification.ok || report.verdict !== 'pass') process.exit(1);
