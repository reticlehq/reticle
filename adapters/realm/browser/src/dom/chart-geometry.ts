/**
 * A chart's plotted values as geometry: each shape of an SVG chart (a bar, a dot, a line, a slice) as
 * its box relative to the chart's own box, in percent. A wrong value moves a shape. A chart drawn
 * larger, elsewhere on the page or in other colours reads the same, because only relative geometry is
 * read: no colour, no stroke, no page position.
 *
 * Opt-in (`SnapshotOptions.charts`): a page read without it does not change.
 */

/** Shapes kept per chart; more are cut, and the result says how many (`cut`). */
export const CHART_SHAPE_CAP = 120;

/** Smaller than this is an icon, not a chart. */
const MIN_CHART_WIDTH = 120;
const MIN_CHART_HEIGHT = 60;

/** SVG elements that draw a mark. Text is left out: the tree already reads it. */
const SHAPE_TAGS = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path'];

/** Containers whose children are definitions or clips, not drawn marks. */
const NOT_DRAWN = 'defs, clipPath, mask, pattern, marker, symbol';

export interface ChartReading {
  /** The chart's accessible label, or its position among the charts read ("chart 2"). */
  label: string;
  /** One line per shape: `<tag> <x> <y> <w> <h>` in percent of the chart box, one decimal at most. */
  shapes: string[];
  /** How many shapes were cut by the cap. Absent when none was. */
  cut?: number;
}

const pct = (v: number, of: number): string => {
  const n = Math.round((v / of) * 1000) / 10;
  return Object.is(n, -0) ? '0' : String(n);
};

/** Every SVG under `root` big enough to be a chart, read as relative geometry. */
export function readCharts(root: Element): ChartReading[] {
  const out: ChartReading[] = [];
  const svgs = Array.from(root.querySelectorAll('svg')).filter(
    (s) => null === s.parentElement?.closest('svg'),
  );
  for (const svg of svgs) {
    const frame = svg.getBoundingClientRect();
    if (frame.width < MIN_CHART_WIDTH || frame.height < MIN_CHART_HEIGHT) {
      continue;
    }
    const marks = Array.from(svg.querySelectorAll(SHAPE_TAGS.join(','))).filter(
      (el) => null === el.closest(NOT_DRAWN),
    );
    const shapes: string[] = [];
    for (const el of marks) {
      const b = el.getBoundingClientRect();
      if (0 === b.width && 0 === b.height) {
        continue;
      }
      const x = pct(b.left - frame.left, frame.width);
      const y = pct(b.top - frame.top, frame.height);
      shapes.push(
        `${el.tagName.toLowerCase()} ${x} ${y} ${pct(b.width, frame.width)} ${pct(b.height, frame.height)}`,
      );
    }
    if (0 === shapes.length) {
      continue;
    }
    const label = svg.getAttribute('aria-label') ?? `chart ${String(out.length + 1)}`;
    const kept = shapes.slice(0, CHART_SHAPE_CAP);
    out.push(
      shapes.length > CHART_SHAPE_CAP
        ? { label, shapes: kept, cut: shapes.length - CHART_SHAPE_CAP }
        : { label, shapes: kept },
    );
  }
  return out;
}
