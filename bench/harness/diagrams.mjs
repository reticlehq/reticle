// Phase 5 diagrams: architecture, summary table, token-flow, social cards.
// Reads analysis.json for real numbers where used. Dark, technical, minimal.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const OUT = 'bench/artifacts';
mkdirSync(OUT, { recursive: true });
const a = JSON.parse(readFileSync('bench/raw/analysis.json', 'utf8'));
const t = a.per_tool;
const FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const C = {
  bg: '#0d1117',
  panel: '#161b22',
  grid: '#30363d',
  text: '#c9d1d9',
  faint: '#8b949e',
  pw: '#2f81f7',
  dt: '#e3b341',
  reticle: '#bc8cff',
  accent: '#3fb950',
  danger: '#f85149',
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const W = (f, s) => writeFileSync(`${OUT}/${f}`, s);

// 1. Architecture diagram: Agent -> tool -> browser runtime -> signals
function architecture() {
  const w = 900,
    h = 540;
  const box = (x, y, bw, bh, fill, stroke, title, sub) =>
    `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
    `<text x="${x + bw / 2}" y="${y + (sub ? bh / 2 - 4 : bh / 2 + 5)}" fill="${C.text}" font-size="15" font-family="${FONT}" font-weight="700" text-anchor="middle">${esc(title)}</text>` +
    (sub
      ? `<text x="${x + bw / 2}" y="${y + bh / 2 + 16}" fill="${C.faint}" font-size="11" font-family="${FONT}" text-anchor="middle">${esc(sub)}</text>`
      : '');
  const arrow = (x1, y1, x2, y2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.faint}" stroke-width="1.6" marker-end="url(#ah)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${C.faint}"/></marker></defs>
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<text x="40" y="38" fill="${C.text}" font-size="20" font-family="${FONT}" font-weight="700">Browser verification: where the three tools sit</text>
<text x="40" y="60" fill="${C.faint}" font-size="12" font-family="${FONT}">All three give the agent the same four runtime signals; they differ in how much context each call returns.</text>
${box(360, 86, 180, 50, C.panel, C.accent, 'AI coding agent', 'reads tool output as context')}
${arrow(450, 136, 450, 168)}
<text x="462" y="160" fill="${C.faint}" font-size="10.5" font-family="${FONT}">tool call</text>
${box(150, 170, 200, 78, '#10243e', C.pw, 'Playwright MCP', 'a11y snapshot + net/console')}
${box(360, 170, 180, 78, '#2b2410', C.dt, 'Chrome DevTools MCP', 'CDP: net/console/perf')}
${box(560, 170, 200, 78, '#241a36', C.reticle, 'Reticle', 'in-app SDK + bridge')}
${arrow(250, 248, 360, 300)}${arrow(450, 248, 450, 300)}${arrow(660, 248, 540, 300)}
${box(330, 300, 240, 50, C.panel, C.grid, 'Browser runtime (Chromium)', 'the same running app')}
${arrow(450, 350, 450, 384)}
${box(120, 388, 660, 96, C.panel, C.grid, '', '')}
<text x="450" y="410" fill="${C.text}" font-size="13" font-family="${FONT}" font-weight="700" text-anchor="middle">Runtime signals</text>
${['DOM', 'Network', 'Console', 'Routes'].map((s, i) => `<rect x="${165 + i * 150}" y="424" width="130" height="42" rx="6" fill="#0d1117" stroke="${C.grid}"/><text x="${230 + i * 150}" y="450" fill="${C.accent}" font-size="13" font-family="${FONT}" text-anchor="middle">${s}</text>`).join('')}
<text x="40" y="${h - 12}" fill="${C.faint}" font-size="10.5" font-family="${FONT}">Playwright/DevTools observe from OUTSIDE the page (a11y tree, CDP). Reticle observes from INSIDE (embedded SDK) — more setup, framework-state access, but a shared bridge.</text>
</svg>`;
  W('diagram-architecture.svg', svg);
}

// 2. Summary table image
function summaryTable() {
  const cols = ['Tool', 'Avg tokens*', 'p95 latency', 'Detection acc.', 'FN rate', 'Setup'];
  const setup = {
    playwright: 'zero (external)',
    devtools: 'zero (external)',
    reticle: 'embed SDK + port',
  };
  const name = {
    playwright: 'Playwright MCP',
    devtools: 'Chrome DevTools MCP',
    reticle: 'Reticle',
  };
  const rows = ['playwright', 'devtools', 'reticle'].map((k) => [
    name[k],
    String(t[k].avg_tokens_o200k),
    `${t[k].p95_latency_ms} ms`,
    `${Math.round(t[k].detection_accuracy * 100)}%`,
    `${Math.round((t[k].false_negative_rate ?? 0) * 100)}%`,
    setup[k],
  ]);
  const w = 880,
    rh = 46,
    h = 150 + rows.length * rh;
  const colX = [40, 250, 380, 500, 640, 740];
  let body = '';
  rows.forEach((r, ri) => {
    const y = 150 + ri * rh;
    body += `<rect x="24" y="${y - 30}" width="${w - 48}" height="${rh}" fill="${ri % 2 ? '#11161d' : C.panel}"/>`;
    r.forEach((c, ci) => {
      body += `<text x="${colX[ci]}" y="${y}" fill="${ci === 0 ? C.text : C.faint}" font-size="13.5" font-family="${FONT}" ${ci === 0 ? 'font-weight="700"' : ''}>${esc(c)}</text>`;
    });
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<text x="40" y="44" fill="${C.text}" font-size="20" font-family="${FONT}" font-weight="700">Benchmark summary — Layer A (observation cost)</text>
<text x="40" y="68" fill="${C.faint}" font-size="12" font-family="${FONT}">${a.measured_cells}/${a.total_cells} cells measured. Agent-reasoning tokens (Layer B): NOT MEASURED (needs API key).</text>
${cols.map((c, i) => `<text x="${colX[i]}" y="118" fill="${C.accent}" font-size="12" font-family="${FONT}" font-weight="700">${esc(c)}</text>`).join('')}
<line x1="24" y1="128" x2="${w - 24}" y2="128" stroke="${C.grid}"/>
${body}
<text x="40" y="${h - 16}" fill="${C.faint}" font-size="10.5" font-family="${FONT}">*tokens = tiktoken o200k_base proxy, not Anthropic. Lower avg tokens is not strictly better — see detection columns.</text>
</svg>`;
  W('diagram-summary-table.svg', svg);
}

// 3. Token-flow: real per-call breakdown for one network scenario
function tokenFlow() {
  const obs = JSON.parse(readFileSync('bench/raw/observation-results.json', 'utf8'));
  const pick = (tool) => obs.find((r) => r.scenario === 'hidden-api-500' && r.tool === tool);
  const w = 860,
    h = 360;
  const lane = (y, color, label, total, steps) => {
    let s = `<text x="40" y="${y - 14}" fill="${color}" font-size="14" font-family="${FONT}" font-weight="700">${esc(label)} — ${total} proxy tokens</text>`;
    let x = 40;
    steps.forEach((st) => {
      const bw = Math.max(40, st.tok * 0.5);
      s += `<rect x="${x}" y="${y}" width="${bw}" height="34" rx="4" fill="${color}" opacity="0.85"/>`;
      s += `<text x="${x + bw / 2}" y="${y + 22}" fill="#0d1117" font-size="11" font-family="${FONT}" text-anchor="middle" font-weight="700">${st.tok}</text>`;
      s += `<text x="${x + bw / 2}" y="${y + 50}" fill="${C.faint}" font-size="10" font-family="${FONT}" text-anchor="middle">${esc(st.l)}</text>`;
      x += bw + 14;
    });
    return s;
  };
  const pw = pick('playwright'),
    dt = pick('devtools'),
    ir = pick('reticle');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<text x="40" y="34" fill="${C.text}" font-size="19" font-family="${FONT}" font-weight="700">Token flow — "did the API call fail?" (hidden-api-500)</text>
<text x="40" y="56" fill="${C.faint}" font-size="12" font-family="${FONT}">bar width ∝ proxy tokens per call. Same verdict (500 detected); the cost is in how each tool returns the network view.</text>
${lane(110, C.pw, 'Playwright MCP', pw?.tokens_o200k ?? 0, [
  { l: 'click', tok: 0 },
  { l: 'click', tok: 0 },
  { l: 'network /api/', tok: pw?._obsTokens ?? 0 },
])}
${lane(200, C.dt, 'Chrome DevTools MCP', dt?.tokens_o200k ?? 0, [
  { l: 'click', tok: 0 },
  { l: 'click', tok: 0 },
  { l: 'network fetch/xhr', tok: dt?._obsTokens ?? 0 },
])}
${lane(290, C.reticle, 'Reticle', ir?.tokens_o200k ?? 0, [
  { l: 'act', tok: 0 },
  { l: 'act', tok: 0 },
  { l: 'network status=500', tok: ir?._obsTokens ?? 0 },
])}
</svg>`;
  W('diagram-token-flow.svg', svg);
}

// 4. Social cards (1200x630)
function socialCards() {
  const titles = [
    'Browser verification for AI coding agents',
    "AI agents don't need better reasoning.\nThey need observability.",
    'We benchmarked Playwright MCP\nvs DevTools MCP vs Reticle',
  ];
  titles.forEach((title, i) => {
    const w = 1200,
      h = 630;
    const lines = title.split('\n');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<rect x="0" y="0" width="${w}" height="6" fill="${C.reticle}"/>
<text x="70" y="90" fill="${C.faint}" font-size="20" font-family="${FONT}">reticle · runtime verification benchmark</text>
${lines.map((ln, li) => `<text x="70" y="${260 + li * 76}" fill="${C.text}" font-size="62" font-family="${FONT}" font-weight="800">${esc(ln)}</text>`).join('')}
<text x="70" y="${h - 120}" fill="${C.faint}" font-size="22" font-family="${FONT}">10 regression scenarios · 3 tools · ${a.measured_cells} measured cells · token + latency + detection</text>
<text x="70" y="${h - 70}" fill="${C.accent}" font-size="22" font-family="${FONT}">evidence, not marketing — methodology + raw JSON published</text>
</svg>`;
    W(`social-card-${i + 1}.svg`, svg);
  });
}

architecture();
summaryTable();
tokenFlow();
socialCards();
console.log('diagrams written to', OUT);
