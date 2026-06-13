/**
 * The single source of truth for design values (mirrored as CSS custom properties in styles.css).
 * Aesthetic: "Iris mission-control" — a deep near-black instrument panel with a signature iris
 * gradient (cyan → indigo → violet), aurora glow, and hairline-bordered glass. JS reads these for
 * charts / dynamic styling; CSS reads the matching --vars. Change a value in BOTH places.
 */

export const Colors = {
  bg: '#07080c',
  panel: '#0f111a',
  panelHover: '#151826',
  hairline: 'rgba(255,255,255,0.07)',
  border: '#20232f',
  borderStrong: '#2c3040',
  text: '#e9ebf2',
  textMuted: '#9398a8',
  textFaint: '#5b6072',
  // Iris signature
  iris1: '#22d3ee', // cyan
  iris2: '#6366f1', // indigo
  iris3: '#c084fc', // violet
  primary: '#6366f1',
  // Semantic
  success: '#34d399',
  warning: '#f5b544',
  danger: '#fb7185',
  info: '#38bdf8',
} as const;

/** The signature gradient, reused for the brand mark, active nav, primary CTAs, chart strokes. */
export const IRIS_GRADIENT = `linear-gradient(135deg, ${Colors.iris1} 0%, ${Colors.iris2} 52%, ${Colors.iris3} 100%)`;

export const Typography = {
  display: "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif",
  body: "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/** 4px base unit. */
export const Spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '40px',
} as const;

export const Radius = {
  sm: '6px',
  md: '10px',
  lg: '16px',
  xl: '24px',
  full: '9999px',
} as const;
