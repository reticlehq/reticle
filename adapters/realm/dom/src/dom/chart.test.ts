import { describe, expect, it } from 'vitest';
import {
  inspectChart,
  hasNonFiniteCoordinate,
  isDegenerate,
  geometryNumbers,
  canvasChartData,
} from './chart.js';

function svg(inner: string): Element {
  const host = document.createElement('div');
  host.innerHTML = `<svg data-testid="chart">${inner}</svg>`;
  return host;
}

describe('hasNonFiniteCoordinate', () => {
  it('catches NaN reaching the DOM — the zero-range scale bug', () => {
    // min === max makes (v - min) / (max - min) divide by zero. Every charting implementation that
    // does not guard produces this, the browser renders nothing, and no reader of the store or the
    // screen can tell. There is no chart for which NaN coordinates are correct.
    expect(hasNonFiniteCoordinate('0,10 5,NaN 10,20')).toBe(true);
    expect(hasNonFiniteCoordinate('M0,0 L10,NaN')).toBe(true);
  });

  it('catches Infinity', () => {
    expect(hasNonFiniteCoordinate('0,10 5,Infinity')).toBe(true);
    expect(hasNonFiniteCoordinate('0,10 5,-Infinity')).toBe(true);
  });

  it('passes a healthy path, including negatives, decimals and exponents', () => {
    expect(hasNonFiniteCoordinate('M0,0 L10.5,-3 L1e2,4')).toBe(false);
    expect(hasNonFiniteCoordinate('0,10 5,15 10,20')).toBe(false);
  });
});

describe('isDegenerate', () => {
  it('flags geometry with no coordinates at all', () => {
    expect(isDegenerate('')).toBe(true);
    expect(isDegenerate('   ')).toBe(true);
  });

  it('flags every point being identical (renders nothing)', () => {
    expect(isDegenerate('5,5 5,5 5,5')).toBe(true);
  });

  it('does NOT flag a flat line — constant data is real data', () => {
    // The distinction that keeps this from being a false-positive generator: a chart of a metric that
    // did not change is a correct chart, and it looks exactly like a broken one to a naive check.
    expect(isDegenerate('0,10 5,10 10,10')).toBe(false);
  });

  it('does not flag a normal varying series', () => {
    expect(isDegenerate('0,10 5,15 10,3')).toBe(false);
  });
});

describe('geometryNumbers', () => {
  it('extracts coordinates from path commands without parsing the path grammar', () => {
    expect(geometryNumbers('M0,10 L5,20')).toEqual([0, 10, 5, 20]);
  });
});

describe('inspectChart', () => {
  it('reports a NaN polyline with enough detail to locate it', () => {
    const report = inspectChart(svg('<polyline points="0,10 5,NaN"/>'));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      kind: 'non-finite-coordinates',
      tag: 'polyline',
      attr: 'points',
    });
    expect(report.findings[0]?.sample).toContain('NaN');
  });

  it('reports an empty series as empty, not as healthy', () => {
    // The case a presence check calls green: the <svg> and <polyline> both exist, so "is the chart
    // there" passes while the chart shows nothing. Reported as its own kind rather than folded into
    // degenerate — "no data reached the chart" and "the data collapsed to one point" have different
    // causes, and the kind is what an agent branches on.
    const report = inspectChart(svg('<polyline points=""/>'));
    expect(report.findings[0]?.kind).toBe('empty-geometry');
  });

  it('stays silent on a healthy chart', () => {
    const report = inspectChart(svg('<polyline points="0,10 5,15 10,3"/><path d="M0,0 L10,10"/>'));
    expect(report.findings).toEqual([]);
    expect(report.examined).toBe(2);
  });

  it('ignores axes and gridlines — a zero-extent line is normal there', () => {
    const report = inspectChart(svg('<line x1="0" y1="0" x2="0" y2="0"/><rect width="0"/>'));
    expect(report.examined).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('declares a canvas rather than reporting a false all-clear', () => {
    // Silence about a canvas would be a lie by omission: there IS no DOM geometry to examine, so an
    // empty findings list must not read as "the chart is fine".
    const host = document.createElement('div');
    host.innerHTML = '<canvas></canvas>';
    const report = inspectChart(host);
    expect(report.canvas).toBe(true);
    expect(report.examined).toBe(0);
  });

  it('truncates a huge path in the sample rather than shipping it whole', () => {
    const long = Array.from({ length: 400 }, (_, i) => `${i},NaN`).join(' ');
    const report = inspectChart(svg(`<polyline points="${long}"/>`));
    expect(report.findings[0]?.sample.length).toBeLessThan(140);
  });
});

describe('canvasChartData', () => {
  it('reads Chart.js data off the canvas — the only route that is not pixels', () => {
    const canvas = document.createElement('canvas');
    const data = { datasets: [{ label: 'deploys', data: [1, 2, 3] }] };
    const out = canvasChartData(canvas, { Chart: { getChart: () => ({ data }) } });
    expect(out).toEqual({ library: 'chartjs', data });
  });

  it('reads ECharts series via getOption', () => {
    const canvas = document.createElement('canvas');
    const option = { series: [{ type: 'line', data: [4, 5] }] };
    const out = canvasChartData(canvas, {
      echarts: { getInstanceByDom: () => ({ getOption: () => option }) },
    });
    expect(out).toEqual({ library: 'echarts', data: option });
  });

  it('returns null when neither library owns the canvas, rather than guessing', () => {
    expect(canvasChartData(document.createElement('canvas'), {})).toBeNull();
  });
});

describe('describe() surfaces chart faults on the descriptor', () => {
  it('a broken chart self-reports without a separate tool call', async () => {
    const { describe: describeEl } = await import('./a11y.js');
    const host = document.createElement('div');
    host.innerHTML = '<svg data-testid="chart"><polyline points="0,10 5,NaN"/></svg>';
    document.body.appendChild(host);
    const d = describeEl(host.firstElementChild as Element);
    expect(d.chart?.[0]?.kind).toBe('non-finite-coordinates');
    host.remove();
  });

  it('a healthy chart adds NO field, so the common case costs zero bytes', async () => {
    const { describe: describeEl } = await import('./a11y.js');
    const host = document.createElement('div');
    host.innerHTML = '<svg><polyline points="0,10 5,15 10,3"/></svg>';
    document.body.appendChild(host);
    const d = describeEl(host.firstElementChild as Element);
    expect('chart' in d).toBe(false);
    host.remove();
  });
});
