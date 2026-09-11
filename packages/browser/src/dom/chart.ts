/**
 * Chart inspection — the one dashboard surface Reticle could not previously see.
 *
 * A chart is where the store and the screen diverge most easily and most silently. Everything else on
 * a dashboard is text: a KPI card renders a number you can read, a table renders rows you can count,
 * and if the store disagrees with either, a state-vs-DOM comparison catches it. A chart renders
 * GEOMETRY — the data has been through a scale function into `points`/`d` coordinates — and geometry
 * is not text. `series` can be perfectly correct in the store while the polyline is blank, flat, or
 * full of NaN, and no reader of either side would notice.
 *
 * Two failure classes are worth detecting, and they are chosen because they are DECIDABLE from the
 * element alone — no baseline image, no per-library scale inversion, no false positives from a chart
 * that is merely ugly:
 *
 *  1. **Non-finite coordinates.** `NaN`/`Infinity` in a path reaches the DOM whenever the scale math
 *     divides by a zero range — an empty series, a single-point series, or min === max. The browser
 *     silently renders nothing. This is a genuine bug every time; there is no chart for which NaN
 *     coordinates are correct.
 *  2. **Degenerate geometry.** A chart element that exists but encloses no area: no points at all, or
 *     every point identical. Distinguishes "the chart is missing" (already catchable — the element is
 *     absent) from "the chart is present and empty", which looks healthy to a presence check and to a
 *     screenshot diff against a baseline that was also empty.
 *
 * Deliberately NOT attempted: comparing plotted geometry against the source data. That needs the
 * chart's scale functions inverted per library, is a large surface to get wrong, and `chartInstance`
 * below obsoletes it for the libraries people actually use — Chart.js and ECharts both hang their
 * instance off the canvas element, so their data can be read directly rather than reverse-engineered
 * from pixels.
 */

/** Elements whose geometry encodes data. `line`/`circle`/`rect` are excluded: they are used for axes,
 *  gridlines and backgrounds, where a zero-extent element is normal rather than a fault. */
const GEOMETRY_TAGS = ['path', 'polyline', 'polygon'] as const;

/** Attributes carrying that geometry, per tag. */
const GEOMETRY_ATTRS = ['d', 'points'] as const;

export interface ChartFinding {
  /** What is wrong, as a stable machine-readable kind. */
  kind: 'non-finite-coordinates' | 'empty-geometry' | 'degenerate-geometry';
  /** The offending element's tag, so the agent can find it. */
  tag: string;
  /** Which attribute carried the fault. */
  attr: string;
  /** A short excerpt of the offending value — bounded; the full path can be thousands of chars. */
  sample: string;
}

export interface ChartReport {
  /** How many data-bearing geometry elements were examined. */
  examined: number;
  findings: ChartFinding[];
  /** True when a canvas is present, i.e. the geometry is NOT in the DOM and this report cannot see it. */
  canvas: boolean;
}

const SAMPLE_MAX = 120;

/**
 * Every number embedded in a geometry attribute. Path data interleaves single-letter drawing
 * commands with coordinate pairs, so this extracts numeric-looking tokens rather than parsing the
 * path grammar — the question here is only "is any coordinate non-finite", which does not need a
 * full parser.
 */
export function geometryNumbers(value: string): number[] {
  const tokens = value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?|NaN|Infinity|-Infinity/gi) ?? [];
  return tokens.map((t) => Number(t));
}

/** True when the attribute contains a coordinate the browser cannot render. */
export function hasNonFiniteCoordinate(value: string): boolean {
  // Checked textually first: `NaN` and `Infinity` survive into the attribute as literal words, and a
  // string scan catches them without depending on how the number extractor tokenises.
  if (/NaN|Infinity/i.test(value)) return true;
  return geometryNumbers(value).some((n) => !Number.isFinite(n));
}

/** True when the geometry encloses no area — no coordinates, or every coordinate pair identical. */
export function isDegenerate(value: string): boolean {
  const nums = geometryNumbers(value).filter((n) => Number.isFinite(n));
  if (0 === nums.length) return true;
  // A polyline of one repeated point draws nothing. Compare pairs, not raw numbers, so a legitimately
  // flat line (varying x, constant y) is NOT flagged — that is a real chart of constant data.
  const xs = nums.filter((_, i) => 0 === i % 2);
  const ys = nums.filter((_, i) => 1 === i % 2);
  const allSame = (arr: number[]): boolean => arr.every((v) => v === arr[0]);
  return xs.length > 1 && allSame(xs) && allSame(ys);
}

/**
 * Inspect a subtree for chart geometry faults. Pure over the element — no events, no globals — so it
 * can back a tool call, an assertion, or a snapshot annotation without any of them owning it.
 */
export function inspectChart(root: Element): ChartReport {
  const findings: ChartFinding[] = [];
  let examined = 0;

  for (const tag of GEOMETRY_TAGS) {
    for (const el of Array.from(root.querySelectorAll(tag))) {
      for (const attr of GEOMETRY_ATTRS) {
        const value = el.getAttribute(attr);
        if (null === value) continue;
        examined += 1;
        const sample = value.length > SAMPLE_MAX ? `${value.slice(0, SAMPLE_MAX)}…` : value;
        if (hasNonFiniteCoordinate(value)) {
          findings.push({ kind: 'non-finite-coordinates', tag, attr, sample });
        } else if (0 === value.trim().length) {
          findings.push({ kind: 'empty-geometry', tag, attr, sample });
        } else if (isDegenerate(value)) {
          findings.push({ kind: 'degenerate-geometry', tag, attr, sample });
        }
      }
    }
  }

  const canvas = root.querySelectorAll('canvas').length > 0;
  return { examined, findings, canvas };
}

/** The shape a canvas charting library hangs off its canvas element, once located. */
export interface CanvasChartData {
  library: 'chartjs' | 'echarts';
  /** The library's own data structure — series/datasets — read directly, not inferred from pixels. */
  data: unknown;
}

/**
 * Read the data behind a CANVAS chart.
 *
 * Canvas is the one place where "instrument from inside the app" is not merely cheaper than pixels but
 * is the only option at all: the chart is a bitmap, so the DOM shows an empty `<canvas>` and a
 * screenshot shows colours no assertion can interpret. Both major canvas libraries keep their live
 * instance reachable from the element — Chart.js via its registry, ECharts via a per-DOM lookup — so
 * the series data is READABLE rather than reverse-engineerable.
 *
 * Takes the globals as arguments rather than reaching for `window`, so this stays pure and testable
 * and the SDK never depends on either library being present.
 */
export function canvasChartData(
  canvas: Element,
  globals: {
    Chart?: { getChart?: (el: Element) => { data?: unknown } | undefined };
    echarts?: { getInstanceByDom?: (el: Element) => { getOption?: () => unknown } | undefined };
  },
): CanvasChartData | null {
  const chartjs = globals.Chart?.getChart?.(canvas);
  if (chartjs !== undefined && chartjs !== null) {
    return { library: 'chartjs', data: chartjs.data ?? null };
  }
  const echart = globals.echarts?.getInstanceByDom?.(canvas);
  if (echart !== undefined && echart !== null) {
    return { library: 'echarts', data: echart.getOption?.() ?? null };
  }
  return null;
}
