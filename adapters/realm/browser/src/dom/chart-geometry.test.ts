/**
 * A chart's plotted values, read as geometry relative to the chart's own box. A grader compares a
 * reference with a candidate: a wrong value must move a shape, and a correct build that is only drawn
 * larger, or in other colours, must read the same. jsdom lays nothing out, so each box is given here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CHART_SHAPE_CAP, readCharts } from './chart-geometry.js';
import { buildSnapshot } from './snapshot.js';

afterEach(() => {
  document.body.innerHTML = '';
});

const box = (el: Element, left: number, top: number, width: number, height: number): void => {
  el.getBoundingClientRect = () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
};

/** A 3-bar chart at (left, top), `scale` times the base size; `tall` makes the middle bar taller. */
function barChart(left: number, top: number, scale: number, tall = false): void {
  document.body.innerHTML =
    '<svg aria-label="Revenue"><rect id="a"></rect><rect id="b"></rect><rect id="c"></rect></svg>';
  const svg = document.querySelector('svg') as Element;
  box(svg, left, top, 400 * scale, 200 * scale);
  const bars: [string, number][] = [
    ['a', 100],
    ['b', tall ? 160 : 120],
    ['c', 80],
  ];
  bars.forEach(([id, h], i) => {
    box(
      document.getElementById(id) as Element,
      left + (40 + i * 100) * scale,
      top + (200 - h) * scale,
      40 * scale,
      h * scale,
    );
  });
}

describe('readCharts', () => {
  it('reads each bar as a box relative to the chart, in percent, in drawing order', () => {
    barChart(10, 20, 1);
    expect(readCharts(document.body)).toEqual([
      { label: 'Revenue', shapes: ['rect 10 50 10 50', 'rect 35 40 10 60', 'rect 60 60 10 40'] },
    ]);
  });

  it('reads a chart drawn twice as large the same: size and position on the page do not count', () => {
    barChart(10, 20, 1);
    const small = readCharts(document.body);
    barChart(300, 5, 2);
    expect(readCharts(document.body)).toEqual(small);
  });

  it('reads a changed value as a changed shape', () => {
    barChart(10, 20, 1);
    const before = readCharts(document.body);
    barChart(10, 20, 1, true);
    expect(readCharts(document.body)).not.toEqual(before);
  });

  it('leaves an icon alone: an svg too small to be a chart is not read', () => {
    document.body.innerHTML = '<svg><path></path><path></path><path></path></svg>';
    box(document.querySelector('svg') as Element, 0, 0, 24, 24);
    expect(readCharts(document.body)).toEqual([]);
  });

  it('declares the shapes it cut when a chart has more than the cap', () => {
    const n = CHART_SHAPE_CAP + 5;
    document.body.innerHTML = `<svg aria-label="Dots">${'<circle></circle>'.repeat(n)}</svg>`;
    box(document.querySelector('svg') as Element, 0, 0, 400, 200);
    document.querySelectorAll('circle').forEach((c, i) => box(c, i, 100, 4, 4));
    const [chart] = readCharts(document.body);
    expect(chart?.shapes).toHaveLength(CHART_SHAPE_CAP);
    expect(chart?.cut).toBe(5);
  });

  it('is part of a snapshot only when asked for', () => {
    barChart(10, 20, 1);
    expect(buildSnapshot({}).charts).toBeUndefined();
    expect(buildSnapshot({ charts: true }).charts).toHaveLength(1);
  });
});
