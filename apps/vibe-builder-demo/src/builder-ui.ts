/**
 * The Builder builder UI logic. This is the OUTER app in the self-test loop: it is itself instrumented
 * with the Iris SDK (gated on ?iris=1) so an outer Iris can drive and observe it — while its own "Run
 * QA agent" button triggers the INNER Iris (the /api/verify middleware) against the preview iframe.
 *
 * The `builder` store exposes the builder's state (phase + last verdict) so the outer self-test reads
 * the result via iris_state — program truth on the outer layer, mirroring how the inner layer works.
 */
import { iris, registerStore, registerCapabilities } from '@syrin/iris-browser';

interface BuilderVerdict {
  status: string;
  blocked: boolean;
  blind: string;
  engine: string;
  summary?: string;
}
const builderState: { phase: string; generated: boolean; lastVerdict: BuilderVerdict | null } = {
  phase: 'idle',
  generated: false,
  lastVerdict: null,
};

const params = new URLSearchParams(location.search);
if (params.get('iris') === '1') {
  const bridge = params.get('bridge') ?? '4400';
  registerStore('builder', () => ({ ...builderState }));
  registerCapabilities({
    testids: ['prompt', 'generate', 'bug', 'engine', 'verify', 'result', 'preview-frame'],
    stores: ['builder'],
  });
  iris.connect({ url: `ws://localhost:${bridge}/iris`, session: 'builder-ui' });
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const frame = $<HTMLIFrameElement>('frame');
const ph = $('ph');
const bugSel = $<HTMLSelectElement>('bug');
const engineSel = $<HTMLSelectElement>('engine');
let previewUrl = location.origin;

void fetch('/api/builder-config')
  .then((r) => r.json())
  .then((c: { previewUrl: string }) => {
    previewUrl = c.previewUrl;
  });

function loadPreview(): void {
  frame.src = `${previewUrl}/?bug=${bugSel.value}`;
  frame.style.display = 'block';
  ph.style.display = 'none';
  $<HTMLButtonElement>('verify').disabled = false;
}

$('generate').addEventListener('click', () => {
  builderState.phase = 'generating';
  ph.style.display = 'flex';
  ph.textContent = 'Generating…';
  frame.style.display = 'none';
  setTimeout(() => {
    builderState.generated = true;
    builderState.phase = 'previewing';
    loadPreview();
  }, 400);
});

bugSel.addEventListener('change', () => {
  if (frame.style.display === 'block') loadPreview();
});

function checksHtml(checks: Array<{ name: string; status: string; detail: string; fix?: string }>): string {
  return checks
    .map((c) => {
      const ok = c.status === 'pass';
      const fix = c.fix ? `<small style="color:var(--warn)">↳ fix: ${c.fix}</small>` : '';
      return `<div class="check"><span class="mk ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'}</span><span>${c.name}<small>${c.detail}</small>${fix}</span></div>`;
    })
    .join('');
}

interface VerifyResponse {
  blind: string;
  iris: {
    engine: string;
    status: string;
    durationMs: number;
    checks?: Array<{ name: string; status: string; detail: string; fix?: string }>;
    summary?: string;
    failures?: string[];
    steps?: number;
    model?: string;
  };
}

$('verify').addEventListener('click', () => {
  void (async () => {
    const btn = $<HTMLButtonElement>('verify');
    btn.disabled = true;
    const engine = engineSel.value;
    builderState.phase = 'verifying';
    $('result').innerHTML = `<div class="spinner">${engine === 'live' ? 'Live agent reasoning over the sandbox via Iris tools…' : 'Launching headless sandbox, driving the app, reading program truth…'}</div>`;
    try {
      const r = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bug: bugSel.value, engine }),
      });
      const data = (await r.json()) as VerifyResponse & { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'verify failed');
      render(data);
    } catch (e) {
      builderState.phase = 'error';
      $('result').innerHTML = `<div class="banner block">error: ${(e as Error).message}</div>`;
    } finally {
      btn.disabled = false;
    }
  })();
});

function render({ blind, iris: v }: VerifyResponse): void {
  const blocked = v.status === 'fail';
  builderState.phase = 'verified';
  builderState.lastVerdict = { status: v.status, blocked, blind, engine: v.engine, summary: v.summary };
  const banner = blocked
    ? '<div class="banner block">🚫 Iris blocked this build — it would have shipped broken</div>'
    : '<div class="banner ship">✅ Verified — safe to ship</div>';
  const live = v.engine === 'live';
  const body = live
    ? `<p>Live LLM agent · ${v.model ?? ''} · ${v.steps ?? 0} tool calls · ${v.durationMs} ms</p>
       <p style="color:var(--text);font-size:0.85rem;margin-top:0.4rem">${v.summary ?? ''}</p>
       ${(v.failures ?? []).map((f) => `<div class="check"><span class="mk no">✗</span><span>${f}</span></div>`).join('')}`
    : `<p>Headless sandbox + program-truth oracles · ${v.durationMs} ms</p>${checksHtml(v.checks ?? [])}`;
  $('result').innerHTML = `
    ${banner}
    <div class="gate"><h3>Blind gate <span class="pill ${blind === 'pass' ? 'pass' : 'fail'}">${blind.toUpperCase()}</span></h3>
      <p>HTTP-200 + render only — the pre-Iris floor. Sees nothing wrong with a silent failure.</p></div>
    <div class="gate"><h3>Iris gate <span style="font-size:0.7rem;color:var(--dim)">${live ? 'live agent' : 'scripted'}</span> <span class="pill ${v.status === 'pass' ? 'pass' : 'fail'}">${v.status.toUpperCase()}</span></h3>${body}</div>
    <p class="contrast">Blind says <b>ship</b>; Iris says <b>${blocked ? 'block' : 'ship'}</b>. The gap is the escaped defect a user would have hit.</p>`;
}
