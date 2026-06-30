// Phase 5 visual assets. Generates clean, technical, dark-theme SVGs from the
// MEASURED analysis.json + observation-results.json. No invented numbers.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'bench/artifacts';
mkdirSync(OUT, { recursive: true });
const analysis = JSON.parse(readFileSync('bench/raw/analysis.json', 'utf8'));
const rows = JSON.parse(readFileSync('bench/raw/observation-results.json', 'utf8'));

const C = {
  bg: '#0d1117',
  panel: '#161b22',
  grid: '#30363d',
  text: '#c9d1d9',
  faint: '#8b949e',
  playwright: '#2f81f7',
  devtools: '#e3b341',
  reticle: '#bc8cff',
  accent: '#3fb950',
};
const TOOLS = ['playwright', 'devtools', 'reticle'];
const LABEL = { playwright: 'Playwright MCP', devtools: 'Chrome DevTools MCP', reticle: 'Reticle' };
const FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Generic grouped/single bar chart.
function barChart({ file, title, subtitle, data, unit, source, w = 760, h = 460 }) {
  const padL = 70,
    padR = 24,
    padT = 78,
    padB = 70;
  const plotW = w - padL - padR,
    plotH = h - padT - padB;
  const max = Math.max(...data.map((d) => d.value), 1);
  const niceMax = Math.ceil(max / 4) * 4 || max;
  const n = data.length;
  const gap = 28;
  const bw = (plotW - gap * (n - 1)) / n;
  let bars = '';
  data.forEach((d, i) => {
    const bh = (d.value / niceMax) * plotH;
    const x = padL + i * (bw + gap);
    const y = padT + plotH - bh;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${d.color}"/>`;
    bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" fill="${C.text}" font-size="14" font-family="${FONT}" text-anchor="middle" font-weight="600">${esc(d.value)}</text>`;
    const lines = d.label.split('\n');
    lines.forEach((ln, li) => {
      bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${(padT + plotH + 22 + li * 15).toFixed(1)}" fill="${C.faint}" font-size="12" font-family="${FONT}" text-anchor="middle">${esc(ln)}</text>`;
    });
  });
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const val = (niceMax / 4) * g;
    const y = padT + plotH - (g / 4) * plotH;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    grid += `<text x="${padL - 10}" y="${(y + 4).toFixed(1)}" fill="${C.faint}" font-size="11" font-family="${FONT}" text-anchor="end">${Math.round(val)}</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<text x="${padL}" y="34" fill="${C.text}" font-size="19" font-family="${FONT}" font-weight="700">${esc(title)}</text>
<text x="${padL}" y="56" fill="${C.faint}" font-size="13" font-family="${FONT}">${esc(subtitle)}</text>
<text transform="translate(20,${padT + plotH / 2}) rotate(-90)" fill="${C.faint}" font-size="12" font-family="${FONT}" text-anchor="middle">${esc(unit)}</text>
${grid}${bars}
<text x="${padL}" y="${h - 16}" fill="${C.faint}" font-size="10.5" font-family="${FONT}">${esc(source)}</text>
</svg>`;
  writeFileSync(`${OUT}/${file}.svg`, svg);
  return `${file}.svg`;
}

const SOURCE = `Source: Layer A (observation cost), ${analysis.measured_cells}/${analysis.total_cells} cells. tokens=tiktoken o200k proxy, not Anthropic.`;
const t = analysis.per_tool;

barChart({
  file: 'chart-avg-tokens',
  title: 'Average observation-cost per verification cycle',
  subtitle: 'lower is better — proxy tokens injected into agent context per scenario',
  unit: 'proxy tokens (o200k)',
  source: SOURCE,
  data: TOOLS.map((k) => ({ label: LABEL[k], value: t[k].avg_tokens_o200k, color: C[k] })),
});

barChart({
  file: 'chart-latency',
  title: 'p95 verification latency',
  subtitle: 'wall-clock per cycle incl. server spawn, login, navigation, observation',
  unit: 'milliseconds',
  source: SOURCE,
  data: TOOLS.map((k) => ({ label: LABEL[k], value: t[k].p95_latency_ms, color: C[k] })),
});

barChart({
  file: 'chart-detection',
  title: 'Detection accuracy',
  subtitle: 'fraction of scenarios graded correctly vs expected (incl. control)',
  unit: 'accuracy x100',
  source: SOURCE,
  data: TOOLS.map((k) => ({
    label: LABEL[k],
    value: Math.round(t[k].detection_accuracy * 100),
    color: C[k],
  })),
});

barChart({
  file: 'chart-fn-rate',
  title: 'False-negative rate',
  subtitle: 'missed real regressions / all real regressions — lower is better',
  unit: 'FN rate x100',
  source: SOURCE,
  data: TOOLS.map((k) => ({
    label: LABEL[k],
    value: Math.round((t[k].false_negative_rate ?? 0) * 100),
    color: C[k],
  })),
});

console.log(
  'charts written:',
  ['chart-avg-tokens', 'chart-latency', 'chart-detection', 'chart-fn-rate']
    .map((x) => x + '.svg')
    .join(', '),
);
